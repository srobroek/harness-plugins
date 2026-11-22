import { afterEach, describe, expect, test } from "bun:test";
import { closeInvocations as findCloseInvocations, parse, tokenizeShell } from "@srobroek/opencode-lib/beads-shell";
import { decideBdCloseParsed, denyReason, setBdShowRunForTests } from "./bd-close-gate.ts";
const tokenize = (command) => tokenizeShell(command).map(({ value }) => value);
/** The close decision for a command line, through the parsed path production uses. */
function decideBdClose(command, cwd = process.cwd()) {
    return decideBdCloseParsed(parse(command), cwd);
}
/** Shapes recorded from bd 1.1.2 `bd show --json`. */
function row(id, issueType) {
    return { id, title: `t ${id}`, status: "open", priority: 2, issue_type: issueType };
}
/** A fake `bd show` over a fixed id -> issue_type table, recording every call. */
function fakeBd(table, calls = []) {
    const run = (argv, cwd) => {
        calls.push({ argv, cwd });
        const ids = argv.slice(argv.indexOf("show") + 1).filter((a) => !a.startsWith("--"));
        const found = ids.filter((id) => id in table);
        if (found.length === 0) {
            return {
                exitCode: 1,
                stdout: JSON.stringify({ error: "no issues found matching the provided IDs" }),
            };
        }
        return {
            exitCode: 0,
            stdout: JSON.stringify(found.map((id) => row(id, table[id]))),
        };
    };
    return { run, calls };
}
afterEach(() => {
    setBdShowRunForTests(null);
});
describe("tokenize", () => {
    test("keeps a quoted reason as one token", () => {
        expect(tokenize('bd close a-1 --reason "then bd close b-2"')).toEqual([
            "bd",
            "close",
            "a-1",
            "--reason",
            "then bd close b-2",
        ]);
    });
    test("separators become their own tokens", () => {
        expect(tokenize("bd close a-1 && bd close b-2")).toEqual(["bd", "close", "a-1", "&", "&", "bd", "close", "b-2"]);
    });
    test("a quoted here-document body is data, not commands", () => {
        const command = "git commit -F - <<'EOF'\nfix: x\n\nrun bd close a-1 after\nEOF\necho done";
        expect(tokenize(command)).toEqual(["git", "commit", "-F", "-", "\n", "echo", "done"]);
    });
    test("an unquoted here-document body is executable source", () => {
        const command = "git commit -F - <<EOF\nrun bd close a-1 after\nEOF\necho done";
        expect(tokenize(command)).toEqual([
            "git",
            "commit",
            "-F",
            "-",
            "\n",
            "run",
            "bd",
            "close",
            "a-1",
            "after",
            "\n",
            "echo",
            "done",
        ]);
    });
    test("the rest of the redirection's line stays commands", () => {
        const command = "cat <<EOF | bd close a-1\nbd close b-2\nEOF\n";
        expect(tokenize(command)).toEqual(["cat", "|", "bd", "close", "a-1", "\n", "bd", "close", "b-2", "\n"]);
    });
    test("<<- strips leading tabs before matching the terminator", () => {
        expect(tokenize("cat <<-EOF\n\tbd close a-1\n\tEOF\nbd close b-2")).toEqual([
            "cat",
            "\n",
            "bd",
            "close",
            "a-1",
            "\n",
            "bd",
            "close",
            "b-2",
        ]);
    });
    test("an unterminated unquoted body is still executable source", () => {
        expect(tokenize("cat <<EOF\nbd close a-1")).toEqual(["cat", "\n", "bd", "close", "a-1"]);
    });
    test("a here-string is not a here-document", () => {
        expect(tokenize("bd close a-1 <<< x")).toEqual(["bd", "close", "a-1", "<<<", "x"]);
    });
});
describe("findCloseInvocations", () => {
    test("plain close", () => {
        expect(findCloseInvocations("bd close bdp-47b")).toEqual([{ ids: ["bdp-47b"], dbArgs: [] }]);
    });
    test("multiple ids in one close", () => {
        expect(findCloseInvocations("bd close bdp-1a bdp-2b bdp-3c --reason done")).toEqual([
            { ids: ["bdp-1a", "bdp-2b", "bdp-3c"], dbArgs: [] },
        ]);
    });
    test("done is an alias for close", () => {
        expect(findCloseInvocations("bd done bdp-47b")).toEqual([{ ids: ["bdp-47b"], dbArgs: [] }]);
    });
    test("-C before the verb is captured as a db selector", () => {
        expect(findCloseInvocations("bd -C /repo close bdp-47b")).toEqual([{ ids: ["bdp-47b"], dbArgs: ["-C", "/repo"] }]);
    });
    test("db selectors after the verb, long and = forms", () => {
        expect(findCloseInvocations("bd close bdp-47b --db=/tmp/x.db --global")).toEqual([
            { ids: ["bdp-47b"], dbArgs: ["--db=/tmp/x.db", "--global"] },
        ]);
        expect(findCloseInvocations("bd close bdp-47b --directory /repo")).toEqual([
            { ids: ["bdp-47b"], dbArgs: ["--directory", "/repo"] },
        ]);
    });
    test("a value flag never contributes its value as an id", () => {
        expect(findCloseInvocations("bd close bdp-47b --reason gate-done")).toEqual([{ ids: ["bdp-47b"], dbArgs: [] }]);
        expect(findCloseInvocations("bd close bdp-47b -r some-reason --session s-1")).toEqual([
            { ids: ["bdp-47b"], dbArgs: [] },
        ]);
    });
    test("boolean close flags pass through", () => {
        expect(findCloseInvocations("bd close bdp-47b --force --suggest-next")).toEqual([{ ids: ["bdp-47b"], dbArgs: [] }]);
    });
    test("an unquoted heredoc body exposes bd close", () => {
        expect(findCloseInvocations("cat <<EOF\nbd close gate-1\nEOF")).toEqual([{ ids: ["gate-1"], dbArgs: [] }]);
        expect(findCloseInvocations("cat <<'EOF'\nbd close gate-1\nEOF")).toEqual([]);
    });
    test("other bd verbs are not close", () => {
        for (const cmd of [
            "bd show bdp-47b",
            "bd gate resolve bdp-47b",
            "bd gate check",
            "bd list --json",
            "bd update bdp-47b --status open",
            "git commit -m 'close bdp-47b'",
        ]) {
            expect(findCloseInvocations(cmd)).toEqual([]);
        }
    });
    test("a quoted close inside a reason is not a second invocation", () => {
        expect(findCloseInvocations('bd close a-1 --reason "do not bd close b-2"')).toEqual([{ ids: ["a-1"], dbArgs: [] }]);
    });
    test("no literal id: close with a variable, or with none at all", () => {
        expect(findCloseInvocations("bd close $GATE_ID")).toEqual([{ ids: [], dbArgs: [] }]);
        expect(findCloseInvocations("bd close --reason done")).toEqual([{ ids: [], dbArgs: [] }]);
    });
});
describe("gate lookup", () => {
    test("finds the gate among mixed types", async () => {
        const { run } = fakeBd({ "bdp-1a": "task", "bdp-2b": "gate", "bdp-3c": "epic" });
        setBdShowRunForTests(run);
        const reason = (await decideBdClose("bd close bdp-1a bdp-2b bdp-3c"))?.reason ?? "";
        expect(reason).toContain("bdp-2b");
        expect(reason).not.toContain("bdp-1a");
        expect(reason).not.toContain("bdp-3c");
    });
    test("close decisions use the selected database rather than a same-id local bead", async () => {
        setBdShowRunForTests((argv, cwd) => {
            let database = cwd;
            for (let i = 1; i < argv.indexOf("show"); i++) {
                const arg = argv[i];
                if (["-C", "--directory", "--db"].includes(arg))
                    database = argv[++i];
                else if (arg.startsWith("--db="))
                    database = arg.slice("--db=".length);
            }
            return { exitCode: 0, stdout: JSON.stringify([row("bdp-1a", database === "/gates" ? "gate" : "task")]) };
        });
        expect(await decideBdClose("bd close bdp-1a", "/tasks")).toBeUndefined();
        expect((await decideBdClose("bd close bdp-1a", "/gates"))?.block).toBe(true);
        for (const command of [
            "bd -C /gates close bdp-1a",
            "bd --actor test --db=/gates close bdp-1a",
            "bd close bdp-1a --directory /gates",
            "echo bd close bdp-1a; env MODE=test command bd --db /gates done bdp-1a",
            "sudo -u user bd --db /gates close bdp-1a",
        ])
            expect((await decideBdClose(command, "/tasks"))?.block).toBe(true);
        expect(await decideBdClose("bd --db /tasks close bdp-1a", "/gates")).toBeUndefined();
    });
    test("no ids means no spawn", async () => {
        const { run, calls } = fakeBd({});
        setBdShowRunForTests(run);
        expect(await decideBdClose("bd close $GATE_ID")).toBeUndefined();
        expect(await decideBdClose("bd close --reason done")).toBeUndefined();
        expect(calls).toEqual([]);
    });
    test("non-zero exit fails closed", async () => {
        setBdShowRunForTests(() => ({ exitCode: 1, stdout: "" }));
        await expect(decideBdClose("bd close bdp-1a")).rejects.toThrow("bd show lookup failed");
    });
    test("unparseable stdout reports uncertainty", async () => {
        setBdShowRunForTests(() => ({ exitCode: 0, stdout: "bd: command not found" }));
        await expect(decideBdClose("bd close bdp-1a")).rejects.toThrow("unreadable JSON");
    });
    test("the error object shape reports uncertainty", async () => {
        setBdShowRunForTests(() => ({
            exitCode: 0,
            stdout: JSON.stringify({ error: "no issues found", schema_version: 1 }),
        }));
        await expect(decideBdClose("bd close bdp-1a")).rejects.toThrow("gate types remain unverified");
    });
    test("a throwing seam is not swallowed here", async () => {
        setBdShowRunForTests(() => {
            throw new Error("spawn failed");
        });
        await expect(decideBdClose("bd close bdp-2b")).rejects.toThrow("spawn failed");
    });
});
describe("decideBdCloseParsed", () => {
    test("blocks a gate id", async () => {
        const { run } = fakeBd({ "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        const decision = await decideBdClose("bd close bdp-2b --reason approved");
        expect(decision).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("bdp-2b") }));
        expect(decision?.reason).toContain("bd gate check");
        expect(decision?.reason).toContain("bd gate resolve");
    });
    test("blocks when a gate hides among ordinary ids", async () => {
        const { run } = fakeBd({ "bdp-1a": "task", "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        expect((await decideBdClose("bd close bdp-1a bdp-2b"))?.block).toBe(true);
    });
    test("blocks even with --force", async () => {
        const { run } = fakeBd({ "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        expect((await decideBdClose("bd close bdp-2b --force"))?.block).toBe(true);
        expect((await decideBdClose("bd close bdp-2b -f"))?.block).toBe(true);
    });
    test("blocks the second of two chained closes", async () => {
        const { run } = fakeBd({ "bdp-1a": "task", "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        expect((await decideBdClose("bd close bdp-1a && bd close bdp-2b"))?.block).toBe(true);
    });
    test("names every gate once", async () => {
        const { run } = fakeBd({ "bdp-2b": "gate", "bdp-3c": "gate" });
        setBdShowRunForTests(run);
        const reason = (await decideBdClose("bd close bdp-2b bdp-3c && bd close bdp-2b"))?.reason ?? "";
        expect(reason).toContain("bdp-2b, bdp-3c");
    });
    test("allows an ordinary bead", async () => {
        const { run } = fakeBd({ "bdp-1a": "task" });
        setBdShowRunForTests(run);
        expect(await decideBdClose("bd close bdp-1a --reason done")).toBeUndefined();
    });
    test("allows the sanctioned resolution sequence", async () => {
        const { run, calls } = fakeBd({ "bdp-2b": "gate", "bdp-9z": "task" });
        setBdShowRunForTests(run);
        expect(await decideBdClose("bd gate resolve bdp-2b")).toBeUndefined();
        expect(await decideBdClose("bd gate check")).toBeUndefined();
        expect(calls).toEqual([]);
        expect(await decideBdClose("bd close bdp-9z --reason 'gate answered'")).toBeUndefined();
    });
    test("mentions never query gates but a following real close still does", async () => {
        const { run, calls } = fakeBd({ "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        for (const command of [
            "echo bd close bdp-2b",
            "printf '%s' bd close bdp-2b",
            "env printf '%s' bd close bdp-2b",
            "command echo bd close bdp-2b",
        ])
            expect(await decideBdClose(command)).toBeUndefined();
        expect(calls).toEqual([]);
        expect((await decideBdClose("echo bd close bdp-2b && command bd close bdp-2b"))?.block).toBe(true);
    });
    test("a real substitution between quoted literals in a parameter default is still read", async () => {
        const { run } = fakeBd({ "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        const blocked = await decideBdClose("echo ${X:-'<('$(bd close bdp-2b)')'}");
        expect(blocked?.block).toBe(true);
        expect((await decideBdClose("echo ${X:- #$(bd close bdp-2b)}"))?.block).toBe(true);
        expect((await decideBdClose("bash 3<<<'bd close bdp-2b' 0<&3"))?.block).toBe(true);
        expect((await decideBdClose(`echo \${X:-"\${Y:-'$(bd close bdp-2b)'}"}`))?.block).toBe(true);
    });
    test("a quoted here-document fed to a shell is read as commands", async () => {
        const { run } = fakeBd({ "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        const blocked = await decideBdClose("bash <<'EOF'\nbd close bdp-2b\nEOF");
        expect(blocked?.block).toBe(true);
        expect(await decideBdClose("cat <<'EOF'\nbd close bdp-2b\nEOF")).toBeUndefined();
    });
    test("unrelated commands never reach the seam", async () => {
        const { run, calls } = fakeBd({ "bdp-2b": "gate" });
        setBdShowRunForTests(run);
        for (const cmd of ["git status", "bd ready --json", "echo close", ""]) {
            expect(await decideBdClose(cmd)).toBeUndefined();
        }
        expect(calls).toEqual([]);
    });
    test("a command-local BEADS_DIR selects the store the lookup reads", async () => {
        const stores = [];
        setBdShowRunForTests((_argv, _cwd, _deadline, env) => {
            stores.push(env?.BEADS_DIR);
            return { exitCode: 0, stdout: JSON.stringify([row("x-1", "task")]) };
        });
        const decision = await decideBdCloseParsed(parse("BEADS_DIR=/b/.beads bd close x-1"), "/a", undefined, {
            BEADS_DIR: "/a/.beads",
        });
        expect(decision).toBeUndefined();
        expect(stores).toEqual(["/b/.beads"]);
    });
    test("reports the existing uncertainty refusal when the shared deadline has lapsed", async () => {
        setBdShowRunForTests(() => ({ exitCode: 0, stdout: JSON.stringify([row("bdp-1a", "task")]) }));
        await expect(decideBdCloseParsed(parse("bd close bdp-1a bdp-2b"), "/repo", Date.now() - 1)).rejects.toThrow("gate types remain unverified");
    });
    test("decisions use the bash cwd", async () => {
        setBdShowRunForTests((_argv, cwd) => ({
            exitCode: 0,
            stdout: JSON.stringify([row("bdp-2b", cwd === "/other/repo" ? "gate" : "task")]),
        }));
        expect(await decideBdClose("bd close bdp-2b", "/other/repo")).toEqual(expect.objectContaining({ block: true }));
        expect(await decideBdClose("bd close bdp-2b", process.cwd())).toBeUndefined();
    });
});
describe("denyReason", () => {
    test("names the gates and both resolution paths", () => {
        const reason = denyReason(["g-1", "g-2"]);
        expect(reason).toContain("g-1, g-2");
        expect(reason).toContain("bd gate resolve");
        expect(reason).toContain("bd gate check");
        expect(reason).toContain("--force");
    });
});
