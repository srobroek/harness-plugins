import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeAgentIds, claudeOutputs, mergeHooks, openCodeAgentFile, staleClaudeFiles } from "./build-claude.ts";
let dir;
/**
 * The guard tests start Bun or Node. Measured: a hook subprocess test runs in about 0.2 s alone
 * and passed the 5 s default under a full `bun run check`.
 */
const SPAWN_MS = 30_000;
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "build-claude-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
const openCodeAgent = (mode, tools) => `---\ndescription: "An agent."\nmode: ${mode}\nsteps: 40\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: deny\n${tools
    .map((tool) => `  - action: ${tool}\n    resource: "*"\n    effect: allow\n`)
    .join("")}---\n\nPrompt.\n`;
const guardedAgent = openCodeAgent("subagent", ["read"]).replace("---\n\nPrompt.", '  - action: read\n    resource: "*.env"\n    effect: ask\n---\n\nPrompt.');
const agentMap = (files) => new Map(Object.entries(files));
const at = (outputs, file) => outputs.find((output) => output.file === path.join(dir, file))?.contents;
const write = (outputs) => {
    for (const output of outputs) {
        mkdirSync(path.dirname(output.file), { recursive: true });
        writeFileSync(output.file, output.contents);
    }
};
describe("claudeOutputs", () => {
    test("translates every non-primary agent into common/agents/<id>.claude.md", () => {
        const outputs = claudeOutputs({ dir, agents: agentMap({ lead: openCodeAgent("primary", ["read"]), reader: openCodeAgent("subagent", ["read", "grep"]) }) });
        expect(at(outputs, "common/agents/reader.claude.md")).toContain("\ntools: Read, Grep\nmaxTurns: 40\n");
        expect(at(outputs, "common/agents/lead.claude.md")).toBeUndefined();
    });
    test("an empty claudeAgents list translates nothing", () => {
        expect(claudeOutputs({ dir, agents: agentMap({ reader: openCodeAgent("subagent", ["read"]) }), selected: [] })).toEqual([]);
    });
    test("writes no hooks file for a plugin with neither hooks nor guarded agents", () => {
        const outputs = claudeOutputs({ dir, agents: agentMap({ reader: openCodeAgent("subagent", ["read"]) }) });
        expect(outputs.map((output) => path.relative(dir, output.file))).toEqual(["common/agents/reader.claude.md"]);
    });
    test("ships a PreToolUse guard for an agent with a restricted ask and merges it into hooks.json", () => {
        const outputs = claudeOutputs({ dir, agents: agentMap({ reader: guardedAgent, plain: openCodeAgent("subagent", ["read"]) }) });
        expect(JSON.parse(at(outputs, "claude/hooks/agent-guards.json"))).toEqual({
            reader: [{ tools: ["Read"], rules: [{ resource: "*.env", effect: "ask" }] }],
        });
        expect(at(outputs, "claude/hooks/agent-guard.mjs")).toContain("guardDecision");
        const hooks = JSON.parse(at(outputs, "claude/hooks/hooks.json"));
        expect(hooks.hooks.PreToolUse[0]?.matcher).toBe("Read");
        expect(hooks.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("$" + "{CLAUDE_PLUGIN_ROOT}/hooks/agent-guard.mjs");
    });
    test("lists the guard hook after the plugin's own hooks of the same event", () => {
        writeFileSync(path.join(dir, "claude-hooks.json"), JSON.stringify({ description: "Own.", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }], SessionStart: [{ matcher: "startup", hooks: [] }] } }));
        const outputs = claudeOutputs({ dir, agents: agentMap({ reader: guardedAgent }) });
        const hooks = JSON.parse(at(outputs, "claude/hooks/hooks.json"));
        expect(hooks.hooks.PreToolUse?.map((entry) => entry.matcher)).toEqual(["Bash", "Read"]);
        expect(Object.keys(hooks.hooks)).toEqual(["PreToolUse", "SessionStart"]);
        expect(hooks.description.startsWith("Own. ")).toBe(true);
    });
    test("copies the plugin's own hooks to hooks/hooks.json", () => {
        const own = { description: "Own.", hooks: { SessionStart: [{ matcher: "startup", hooks: [] }] } };
        writeFileSync(path.join(dir, "claude-hooks.json"), JSON.stringify(own));
        expect(JSON.parse(at(claudeOutputs({ dir, agents: agentMap({}) }), "claude/hooks/hooks.json"))).toEqual(own);
    });
    test("the shipped guard asks for a guarded read when run as the hook command does", async () => {
        write(claudeOutputs({ dir, agents: agentMap({ reader: guardedAgent }) }));
        const proc = Bun.spawn(["bun", path.join(dir, "claude/hooks/agent-guard.mjs")], {
            stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Read", agent_type: "alpha:reader", tool_input: { file_path: "/r/.env" } })),
            stdout: "pipe",
        });
        expect(JSON.parse(await new Response(proc.stdout).text()).hookSpecificOutput.permissionDecision).toBe("ask");
    }, SPAWN_MS);
    // A load hook that hides `import.meta.main` from .mjs files, as on Node before 22.18 and 24.2.
    const WITHOUT_IMPORT_META_MAIN = `data:text/javascript,import { register } from "node:module"; register(${JSON.stringify('data:text/javascript,export async function load(url, context, next) { const out = await next(url, context); if (url.endsWith(".mjs")) out.source = String(out.source).replaceAll("import.meta.main", "undefined"); return out }')})`;
    test.each([
        ["Node", []],
        ["a Node without import.meta.main", ["--import", WITHOUT_IMPORT_META_MAIN]],
    ])("the shipped guard asks for a guarded read under %s through a symlinked plugin directory", async (_, flags) => {
        write(claudeOutputs({ dir, agents: agentMap({ reader: guardedAgent }) }));
        // Claude Code may reach a plugin through a symlink, so the script path is not its real path.
        const linked = path.join(dir, "linked-alpha");
        symlinkSync(path.join(dir, "claude"), linked);
        const proc = Bun.spawn(["node", ...flags, path.join(linked, "hooks/agent-guard.mjs")], {
            stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Read", agent_type: "alpha:reader", tool_input: { file_path: "/r/.env" } })),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, code] = [await new Response(proc.stdout).text(), await proc.exited];
        expect(code).toBe(0);
        expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    }, SPAWN_MS);
});
describe("claudeAgentIds", () => {
    const agents = agentMap({ lead: openCodeAgent("primary", ["read"]), b: openCodeAgent("subagent", ["read"]), a: openCodeAgent("subagent", ["read"]) });
    test("defaults to every non-primary agent, in id order", () => {
        expect(claudeAgentIds("p", agents, undefined)).toEqual(["a", "b"]);
    });
    test("returns the selection without duplicates, in id order", () => {
        expect(claudeAgentIds("p", agents, ["b", "a", "b"])).toEqual(["a", "b"]);
    });
    test.each([
        ["an agent that is not in common/agents/", ["missing"], 'names "missing", which is not in common/agents/'],
        ["a primary agent", ["lead"], 'names the primary agent "lead"'],
    ])("rejects claudeAgents naming %s", (_, selected, message) => {
        expect(() => claudeAgentIds("p", agents, selected)).toThrow(message);
    });
});
describe("openCodeAgentFile", () => {
    test.each([
        [true, "reader.opencode.md"],
        [false, "reader.md"],
    ])("with a Claude Code tree: %p", (claude, name) => {
        expect(openCodeAgentFile("reader", claude)).toBe(name);
    });
});
describe("mergeHooks", () => {
    test("concatenates the entries of each event in file order and joins the descriptions", () => {
        expect(mergeHooks([
            { description: "A.", hooks: { Pre: [1], Start: [2] } },
            { hooks: { Pre: [3] } },
            { description: "C.", hooks: { Pre: [4] } },
        ])).toEqual({ description: "A. C.", hooks: { Pre: [1, 3, 4], Start: [2] } });
    });
});
describe("staleClaudeFiles", () => {
    test("reports translated agents and hook files that a fresh render no longer produces", () => {
        write(claudeOutputs({ dir, agents: agentMap({ reader: guardedAgent }) }));
        const fresh = claudeOutputs({ dir, agents: agentMap({}) });
        expect(staleClaudeFiles({ dir }, fresh)
            .map((file) => path.relative(dir, file))
            .sort()).toEqual(["claude/hooks/agent-guard.mjs", "claude/hooks/agent-guards.json", "claude/hooks/hooks.json", "common/agents/reader.claude.md"]);
    });
});
