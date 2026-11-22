import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "@srobroek/opencode-lib/testing";
import plugin, { createPlugin, PACK_TOOL, REPOMIX_VERSION } from "./index.ts";
const context = { sessionID: "ses_1", agent: "researcher", messageID: "msg_1", id: "call_1", signal: new AbortController().signal };
const SUMMARY = "  Total Files: 2 files\n Total Tokens: 390 tokens\n  Total Chars: 1,785 chars\n";
function fakeRepomix(seen) {
    return async (argv) => {
        seen.push(argv);
        const output = (argv.find((arg) => arg.startsWith("--output=")) ?? "").slice("--output=".length);
        writeFileSync(output, "<files></files>");
        return { kind: "exited", exitCode: 0, signalCode: null, stdout: SUMMARY, stderr: "" };
    };
}
test("registers the tool and the skill with no npx prompt, and disposes them", async () => {
    const fake = createFakeContext();
    const cleanup = await plugin.setup(fake.context);
    expect([...fake.tools.keys()]).toEqual([PACK_TOOL]);
    expect([...fake.skills.keys()]).toEqual(["repomix"]);
    expect(fake.hooks("permission")).toEqual([]);
    await cleanup?.();
    expect(fake.active()).toBe(0);
    expect(fake.tools.size).toBe(0);
});
test.each(["false", "true", 1, "yes"])("a non-boolean confirmPack %p registers no prompt and keeps an allow", async (value) => {
    const fake = createFakeContext({ options: { confirmPack: value } });
    await plugin.setup(fake.context);
    expect(fake.hooks("permission")).toEqual([]);
    const npx = { sessionID: "ses_1", action: PACK_TOOL, resources: ["o/r"], metadata: { runner: "npx" }, effect: "allow" };
    const evaluation = await fake.fire.permission("evaluate", npx);
    expect(evaluation.effect).toBe("allow");
});
test("confirmPack=true prompts for the npx fallback; a deny stays a deny and the default leaves an allow", async () => {
    const npx = { sessionID: "ses_1", action: PACK_TOOL, resources: ["o/r"], metadata: { runner: "npx" } };
    const on = createFakeContext({ options: { confirmPack: true } });
    await plugin.setup(on.context);
    expect(on.hooks("permission")).toEqual(["evaluate"]);
    const asked = await on.fire.permission("evaluate", { ...npx, effect: "allow" });
    expect(asked.effect).toBe("ask");
    const denied = await on.fire.permission("evaluate", { ...npx, effect: "deny" });
    expect(denied.effect).toBe("deny");
    const off = createFakeContext();
    await plugin.setup(off.context);
    const allowed = await off.fire.permission("evaluate", { ...npx, effect: "allow" });
    expect(allowed.effect).toBe("allow");
});
test("a pack asks for the resolved target and returns the path and metrics only", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomix-tool-"));
    try {
        const seen = [];
        const fake = createFakeContext({ directory: "/project" });
        await createPlugin({ root, exec: fakeRepomix(seen), which: () => "/bin/repomix", isDirectory: () => true }).setup(fake.context);
        const pack = fake.tools.get(PACK_TOOL)?.execute;
        const local = await pack({ directory: "plugins/lib", compress: true }, context);
        expect(local.metadata).toMatchObject({ ok: true, status: "packed", runner: "path", files: 2, tokens: 390 });
        expect(local.content).toContain(`to ${root}/repomix-lib-`);
        expect(fake.asserts[0]).toMatchObject({
            action: PACK_TOOL,
            resources: ["/project/plugins/lib"],
            metadata: { runner: "path", compress: true },
        });
        expect(seen[0]?.[0]).toBe("/bin/repomix");
        expect(seen[0]?.at(-1)).toBe("/project/plugins/lib");
        const remote = await pack({ remote: "yamadashy/repomix", ref: "v1.17.0" }, context);
        expect(remote.metadata.ok).toBe(true);
        expect(fake.asserts[1]?.resources).toEqual(["yamadashy/repomix@v1.17.0"]);
        expect(seen[1]?.slice(-2)).toEqual(["--remote=yamadashy/repomix", "--remote-branch=v1.17.0"]);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("refusals return before any permission prompt or run", async () => {
    const seen = [];
    const fake = createFakeContext({ directory: "/project" });
    await createPlugin({ exec: fakeRepomix(seen), which: () => "/bin/repomix", isDirectory: () => false }).setup(fake.context);
    const pack = fake.tools.get(PACK_TOOL)?.execute;
    const missing = await pack({ directory: "nope" }, context);
    expect(missing).toMatchObject({ metadata: { ok: false } });
    expect(missing.content).toContain("/project/nope is not a directory");
    expect((await pack({ remote: "--remote-trust-config" }, context)).metadata.ok).toBe(false);
    expect((await pack({ directory: ".", remote: "o/r" }, context)).metadata.ok).toBe(false);
    expect(fake.asserts).toHaveLength(0);
    expect(seen).toHaveLength(0);
});
test("the npx fallback is flagged for the prompt, and a rejection stops the run", async () => {
    const seen = [];
    const refused = createFakeContext({
        options: { confirmPack: true },
        assert: () => {
            throw new Error("rejected");
        },
    });
    await createPlugin({ exec: fakeRepomix(seen), which: () => null }).setup(refused.context);
    const pack = refused.tools.get(PACK_TOOL)?.execute;
    await expect(pack({ remote: "o/r" }, context)).rejects.toThrow("rejected");
    expect(refused.asserts[0]?.metadata).toMatchObject({ runner: "npx" });
    expect(seen).toHaveLength(0);
    const evaluation = await refused.fire.permission("evaluate", {
        sessionID: "ses_1",
        action: PACK_TOOL,
        resources: ["o/r"],
        metadata: { runner: "npx" },
        effect: "allow",
    });
    expect(evaluation.effect).toBe("ask");
    expect(evaluation.message).toContain(`npx --yes repomix@${REPOMIX_VERSION}`);
});
test("an aborted signal reaches the run and the tool reports it stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomix-tool-"));
    try {
        const signals = [];
        const controller = new AbortController();
        const fake = createFakeContext({ directory: "/project" });
        const exec = async (_argv, options) => {
            signals.push(options.signal);
            controller.abort();
            return { kind: "aborted", stdout: "", stderr: "" };
        };
        await createPlugin({ root, exec, which: () => "/bin/repomix", isDirectory: () => true }).setup(fake.context);
        const pack = fake.tools.get(PACK_TOOL)?.execute;
        const result = await pack({ directory: "." }, { ...context, signal: controller.signal });
        expect(signals).toEqual([controller.signal]);
        expect(result.metadata).toMatchObject({ ok: false, status: "aborted" });
        expect(result.content).toContain("repomix was cancelled");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("a host without ToolContext.signal still packs", async () => {
    const root = mkdtempSync(join(tmpdir(), "repomix-tool-"));
    try {
        const fake = createFakeContext({ directory: "/project" });
        await createPlugin({ root, exec: fakeRepomix([]), which: () => "/bin/repomix", isDirectory: () => true }).setup(fake.context);
        const pack = fake.tools.get(PACK_TOOL)?.execute;
        const { signal: _unused, ...legacy } = context;
        expect((await pack({ directory: "." }, legacy)).metadata).toMatchObject({ ok: true, status: "packed" });
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
