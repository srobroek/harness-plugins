import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture";
// The Claude Code tree is installed on its own: its hook may only find files that sit in the tree.
// claude-hook.process.test.ts runs the source, which finds the runner beside it, so it cannot show
// a runner missing from the package.
const CLAUDE_TREE = join(import.meta.dir, "..", "..", "claude");
/** Each test starts a Bun subprocess; a run takes about 0.2 s alone. */
const SPAWN_MS = 30_000;
let root = "";
beforeAll(() => {
    root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-hook-packaged-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("the packaged hook rewrites an embedded-store write to the runner shipped in the tree", async () => {
    // A copy with nothing around it: no src/, no repository, no OpenCode tree.
    const installed = join(root, "installed");
    cpSync(CLAUDE_TREE, installed, { recursive: true, dereference: true });
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    mkdirSync(join(repo, ".beads", "embeddeddolt"), { recursive: true });
    mkdirSync(bin);
    writeExecutable(join(bin, "bd"), '#!/bin/sh\ncase "$1" in\n  gate) printf \'{"data":[],"schema_version":1}\' ;;\n  *) printf "{}" ;;\nesac\n');
    const proc = Bun.spawn(["bun", join(installed, "dist", "claude-hook.js"), "pre-tool-use"], {
        cwd: repo,
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command: 'bd create "x"' }, tool_use_id: "t1" })),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, BEADS_GATE_VERDICT_DIR: join(root, "verdicts") },
    });
    const [stdout, code] = [await new Response(proc.stdout).text(), await proc.exited];
    expect(code).toBe(0);
    const output = JSON.parse(stdout).hookSpecificOutput;
    expect({ decision: output.permissionDecision, reason: output.permissionDecisionReason }).toEqual({ decision: undefined, reason: undefined });
    const runner = join(installed, "dist", "bd-embedded-write-runner.js");
    expect(output.updatedInput?.command).toContain(runner);
    expect(existsSync(runner)).toBe(true);
}, SPAWN_MS);
