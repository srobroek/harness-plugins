import { describe, expect, test } from "bun:test";
import { Worktree } from "@opencode/plugin";
import { createFakeContext } from "@srobroek/opencode-lib/testing";
import { createPlugin, mergeGateCall, operationError, readOptions, shellCwd } from "./index.ts";
import { STRATEGY_ID } from "./worktree.ts";
/** The lib fake plus the worktree and skill domains this plugin uses. */
function fakeContext(options = {}, sessions = []) {
    const fake = createFakeContext({ options, sessions: sessions });
    const strategies = [];
    const skills = new Map();
    let live = 0;
    const registration = (onDispose) => {
        live++;
        let disposed = false;
        return {
            dispose: async () => {
                if (disposed)
                    return;
                disposed = true;
                live--;
                onDispose();
            },
        };
    };
    const context = fake.context;
    context.worktree = {
        transform: async (callback) => {
            const added = [];
            callback({ add: (definition) => void added.push(definition) });
            strategies.push(...added);
            return registration(() => {
                for (const definition of added)
                    strategies.splice(strategies.indexOf(definition), 1);
            });
        },
    };
    context.skill = {
        transform: async (callback) => {
            const added = [];
            callback({
                get: (id) => skills.get(id),
                add: (skill) => {
                    skills.set(skill.id, skill);
                    added.push(skill.id);
                },
            });
            return registration(() => {
                for (const id of added)
                    skills.delete(id);
            });
        },
    };
    return { fake, strategies, skills, active: () => live + fake.active() };
}
const shell = (command, extra = {}) => ({
    tool: "shell",
    sessionID: "ses_1",
    input: { command, ...extra },
});
const probes = (seen = []) => ({
    git: async (args, cwd) => {
        seen.push(cwd);
        return args[0] === "branch" ? "worker" : "origin/main";
    },
    wt: async () => null,
});
describe("pure helpers", () => {
    test("strategy is on unless explicitly disabled", () => {
        expect(readOptions(undefined).strategy).toBe(true);
        expect(readOptions({ strategy: true }).strategy).toBe(true);
        expect(readOptions({ strategy: false }).strategy).toBe(false);
    });
    test("only shell calls that mention merge are checked", () => {
        expect(mergeGateCall("shell", { command: "ls" })).toBeUndefined();
        expect(mergeGateCall("read", { command: "wt merge x" })).toBeUndefined();
        expect(mergeGateCall("shell", { command: "wt merge x", workdir: "sub" })).toEqual({
            command: "wt merge x",
            workdir: "sub",
        });
    });
    test("workdir resolves against the session directory", () => {
        expect(shellCwd(undefined, "/s")).toBe("/s");
        expect(shellCwd("sub", "/s")).toBe("/s/sub");
        expect(shellCwd("/abs", "/s")).toBe("/abs");
    });
    test("operationError is a Worktree.OperationError with forceRequired only when set", () => {
        const dirty = operationError("dirty", true);
        expect(dirty).toBeInstanceOf(Worktree.OperationError);
        expect(dirty.forceRequired).toBe(true);
        expect(operationError("other").forceRequired).toBeUndefined();
    });
});
describe("setup", () => {
    test("registers the strategy, the gate and the skills, and disposes all of them", async () => {
        const ctx = fakeContext();
        const cleanup = await createPlugin({ probes: probes() }).setup(ctx.fake.context);
        expect(ctx.strategies.map((strategy) => strategy.id)).toEqual([STRATEGY_ID]);
        expect(ctx.fake.hooks("tool")).toEqual(["execute.before"]);
        expect([...ctx.skills.keys()]).toEqual(["worktrunk-preflight", "worktrunk-worktrees"]);
        const skill = ctx.skills.get("worktrunk-preflight");
        expect(skill.path).toMatch(/skills\/worktrunk-preflight\/SKILL\.md$/);
        expect(skill.content).toContain("preflight.py");
        await cleanup();
        expect(ctx.active()).toBe(0);
        expect(ctx.strategies).toHaveLength(0);
        expect(ctx.skills.size).toBe(0);
    });
    test("strategy: false skips the worktree strategy only", async () => {
        const ctx = fakeContext({ strategy: false });
        const cleanup = await createPlugin({ probes: probes() }).setup(ctx.fake.context);
        expect(ctx.strategies).toHaveLength(0);
        expect(ctx.fake.hooks("tool")).toEqual(["execute.before"]);
        await cleanup();
        expect(ctx.active()).toBe(0);
    });
    test("gives a wt switch call the long timeout", async () => {
        const ctx = fakeContext({ strategy: false });
        await createPlugin({ probes: probes() }).setup(ctx.fake.context);
        const event = await ctx.fake.fire.tool("execute.before", shell("wt switch -y --create --no-cd feat"));
        expect(event.input.timeout).toBe(600_000);
    });
    test("keeps a skill the host already has", async () => {
        const ctx = fakeContext();
        ctx.skills.set("worktrunk-worktrees", { id: "worktrunk-worktrees", content: "user override" });
        await createPlugin({ probes: probes() }).setup(ctx.fake.context);
        expect(ctx.skills.get("worktrunk-worktrees")?.content).toBe("user override");
    });
    test("the gate blocks an unflagged epic merge and allows a flagged one", async () => {
        const ctx = fakeContext();
        await createPlugin({ probes: probes() }).setup(ctx.fake.context);
        await expect(ctx.fake.fire.tool("execute.before", shell("wt merge develop"))).rejects.toThrow("worker-to-epic merges must preserve history");
        await ctx.fake.fire.tool("execute.before", shell("wt merge develop --no-squash --no-ff"));
        await ctx.fake.fire.tool("execute.before", shell("wt merge main"));
        await ctx.fake.fire.tool("execute.before", { tool: "read", sessionID: "ses_1", input: { command: "wt merge x" } });
    });
    test("the gate probes the session's directory joined with workdir", async () => {
        const seen = [];
        const ctx = fakeContext({}, [{ id: "ses_1", location: { directory: "/wt/worker" } }]);
        await createPlugin({ probes: probes(seen) }).setup(ctx.fake.context);
        await ctx.fake.fire.tool("execute.before", shell("wt merge develop --no-squash --no-ff", { workdir: "pkg" }));
        expect(seen).toContain("/wt/worker/pkg");
    });
    test("the gate falls back to the plugin location when the session is unknown", async () => {
        const seen = [];
        const ctx = fakeContext();
        await createPlugin({ probes: probes(seen) }).setup(ctx.fake.context);
        await ctx.fake.fire.tool("execute.before", shell("wt merge develop --no-squash --no-ff"));
        expect(seen).toContain("/fake/project");
    });
    test("a failing registration disposes the earlier ones", async () => {
        const ctx = fakeContext();
        const failing = createPlugin({ probes: probes(), skillsDirectory: "/nonexistent" });
        await expect(failing.setup(ctx.fake.context)).rejects.toThrow();
        expect(ctx.active()).toBe(0);
    });
});
