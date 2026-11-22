import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture";
import { SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git";
import { exportReview, revRefusal, safeRepoPath, verifyExport } from "./review-export.ts";
import { runCommand } from "./rundir.ts";
// Each export spawns about ten git processes; measured at 0.2 s on this host, so 30 s is generous for a loaded CI runner.
setDefaultTimeout(30_000);
let work;
let repo;
let runDir;
let outside;
let baseSha;
let headSha;
let sideSha;
const git = (...args) => execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
}).trim();
const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
};
const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
};
beforeAll(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-review-")));
    repo = join(work, "repo");
    runDir = join(work, "run");
    outside = join(work, "outside");
    mkdirSync(repo);
    mkdirSync(runDir);
    mkdirSync(outside);
    git("init", "-q", "-b", "main");
    put("keep.txt", "unchanged\n");
    put("a.txt", "one\n");
    put("gone.txt", "bye\n");
    baseSha = commit("base");
    git("checkout", "-q", "-b", "side");
    put("side-only.txt", "side\n");
    sideSha = commit("side");
    git("checkout", "-q", "main");
    put("a.txt", "one\ntwo\n");
    put("sub/c.ts", "export const c = 1\n");
    put("odd name;$(touch pwned).txt", "odd\n");
    put("blob.bin", Buffer.from([0x89, 0x50, 0, 0x47]));
    put("big.txt", "x".repeat(2000));
    put(":(top)magic.txt", "magic\n");
    rmSync(join(repo, "gone.txt"));
    headSha = commit("head");
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
const read = (...parts) => readFileSync(join(...parts), "utf8");
describe("exportReview", () => {
    test("writes the diff, the diffstat and the changed files at head, and lists them", async () => {
        const result = await exportReview({ run: runCommand, cwd: repo, runDir, base: baseSha, head: "main" });
        if (!result.ok)
            throw new Error(result.reason);
        expect(result.dir).toBe(join(runDir, "review", headSha, result.manifestHash));
        expect(result.base).toBe(baseSha);
        expect(result.head).toBe(headSha);
        expect(result.files.map((file) => file.path).sort()).toEqual([":(top)magic.txt", "a.txt", "big.txt", "odd name;$(touch pwned).txt", "sub/c.ts"]);
        expect(read(result.dir, "files", "a.txt")).toBe("one\ntwo\n");
        expect(read(result.dir, "files", "sub", "c.ts")).toBe("export const c = 1\n");
        expect(existsSync(join(repo, "pwned"))).toBe(false);
        expect(existsSync(join(result.dir, "files", "gone.txt"))).toBe(false);
        expect(existsSync(join(result.dir, "files", "keep.txt"))).toBe(false);
        expect(result.skipped).toEqual([{ path: "blob.bin", reason: "binary" }]);
        const diff = read(result.dir, "round.diff");
        expect(diff).toContain("+two");
        expect(diff).toContain("-bye");
        expect(read(result.dir, "diffstat.txt")).toContain("a.txt");
        expect(result.diff).toBe(join(result.dir, "round.diff"));
        expect(result.diffstat).toBe(join(result.dir, "diffstat.txt"));
    });
    test("exports a file under a subdirectory when cwd is that subdirectory", async () => {
        const result = await exportReview({ run: runCommand, cwd: join(repo, "sub"), runDir: mkdtempSync(join(work, "run-")), base: baseSha, head: "main" });
        if (!result.ok)
            throw new Error(result.reason);
        expect(result.files.map((file) => file.path)).toContain("sub/c.ts");
        expect(result.skipped).toEqual([{ path: "blob.bin", reason: "binary" }]);
        expect(read(result.dir, "files", "sub", "c.ts")).toBe("export const c = 1\n");
    });
    test("uses base...head: changes made only on the base side are not in the diff", async () => {
        const result = await exportReview({ run: runCommand, cwd: repo, runDir, base: "side", head: "main" });
        if (!result.ok)
            throw new Error(result.reason);
        expect(result.base).toBe(sideSha);
        expect(read(result.dir, "round.diff")).not.toContain("side-only");
        expect(read(result.dir, "round.diff")).toContain("+two");
    });
    test("exporting the same content again returns the same published directory untouched", async () => {
        const dir = mkdtempSync(join(work, "run-"));
        const first = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        const second = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        if (!first.ok || !second.ok)
            throw new Error("export refused");
        expect(second.dir).toBe(first.dir);
        expect(second.manifestHash).toBe(first.manifestHash);
        expect(readdirSync(join(dir, "review", headSha))).toEqual([first.manifestHash]);
    });
    test("a damaged published export is moved aside, kept as evidence, and a fresh one is published under the same hash", async () => {
        const dir = mkdtempSync(join(work, "run-"));
        const first = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        if (!first.ok)
            throw new Error(first.reason);
        writeFileSync(join(first.dir, "files", "a.txt"), "evil\n");
        const again = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        if (!again.ok)
            throw new Error(again.reason);
        expect(again.dir).toBe(first.dir);
        expect(verifyExport(again.dir, again.manifestHash).ok).toBe(true);
        const aside = readdirSync(join(dir, "review", headSha)).filter((name) => name.startsWith(".rejected-"));
        expect(aside).toHaveLength(1);
        expect(readFileSync(join(dir, "review", headSha, aside[0], "files", "a.txt"), "utf8")).toBe("evil\n");
    });
    test("a different base publishes a second export beside the first and leaves the first intact", async () => {
        const dir = mkdtempSync(join(work, "run-"));
        const first = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        const second = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: sideSha, head: headSha });
        if (!first.ok || !second.ok)
            throw new Error("export refused");
        expect(second.dir).not.toBe(first.dir);
        expect(verifyExport(first.dir, first.manifestHash).ok).toBe(true);
        expect(verifyExport(second.dir, second.manifestHash).ok).toBe(true);
    });
    test("refuses when review/ is a symlink and writes nothing through it", async () => {
        const dir = mkdtempSync(join(work, "run-"));
        const target = mkdtempSync(join(work, "elsewhere-"));
        symlinkSync(target, join(dir, "review"));
        const result = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("review") });
        expect(readdirSync(target)).toEqual([]);
    });
    test("refuses when review/<head> is a symlink and writes nothing through it", async () => {
        const dir = mkdtempSync(join(work, "run-"));
        const target = mkdtempSync(join(work, "elsewhere-"));
        mkdirSync(join(dir, "review"));
        symlinkSync(target, join(dir, "review", headSha));
        const result = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        expect(result.ok).toBe(false);
        expect(readdirSync(target)).toEqual([]);
    });
    test("leaves no temporary directory behind", async () => {
        const dir = mkdtempSync(join(work, "run-"));
        await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        expect(readdirSync(join(dir, "review", headSha)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    });
    test("a git failure in ls-tree is refused with git's own diagnostic", async () => {
        const run = async (cwd, command, args, timeout) => (args.includes("ls-tree") ? { ok: false, stdout: "", stderr: "fatal: not a tree object\n" } : runCommand(cwd, command, args, timeout));
        const result = await exportReview({ run, cwd: repo, runDir: mkdtempSync(join(work, "run-")), base: baseSha, head: headSha });
        expect(result).toEqual({ ok: false, reason: "git ls-tree failed: fatal: not a tree object" });
    });
    test.each([
        ["a leading dash", "--output=/tmp/x"],
        ["a single dash", "-"],
        ["an empty string", ""],
        ["a newline", "main\nHEAD"],
        ["a space", "main HEAD"],
        ["a NUL", "main\0"],
        ["a very long string", "a".repeat(300)],
    ])("refuses %s as a revision before running git", async (_name, rev) => {
        const calls = [];
        const run = async (_cwd, _command, args) => {
            calls.push(args);
            return { ok: true, stdout: "", stderr: "" };
        };
        for (const input of [
            { base: rev, head: "main" },
            { base: "main", head: rev },
        ]) {
            const result = await exportReview({ run, cwd: repo, runDir, ...input });
            expect(result.ok).toBe(false);
        }
        expect(calls).toEqual([]);
    });
    test("refuses a non-string revision", async () => {
        const result = await exportReview({ run: runCommand, cwd: repo, runDir, base: 5, head: "main" });
        expect(result).toEqual({ ok: false, reason: "base must be a string" });
    });
    test("refuses a revision git cannot resolve to a commit, naming it", async () => {
        const result = await exportReview({ run: runCommand, cwd: repo, runDir, base: "no-such-branch", head: "main" });
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("no-such-branch") });
    });
    test("refuses a revision that names a blob, not a commit", async () => {
        const result = await exportReview({ run: runCommand, cwd: repo, runDir, base: `${baseSha}:keep.txt`, head: "main" });
        expect(result.ok).toBe(false);
    });
    test("refuses histories with no merge base", async () => {
        git("checkout", "-q", "--orphan", "orphan");
        put("o.txt", "o\n");
        const orphan = commit("orphan");
        git("checkout", "-q", "main");
        const result = await exportReview({ run: runCommand, cwd: repo, runDir, base: orphan, head: "main" });
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("merge base") });
    });
    describe("size caps refuse the whole export and write nothing", () => {
        const fresh = () => mkdtempSync(join(work, "run-"));
        test.each([
            ["more changed files than the cap", { files: 3 }, "6 changed files"],
            ["a diff above the cap", { diffBytes: 100 }, "diff is"],
            ["more file content than the cap", { totalBytes: 1000 }, "file content"],
        ])("%s", async (_name, limits, mention) => {
            const dir = fresh();
            const result = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha, limits });
            expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(mention) });
            expect(existsSync(join(dir, "review"))).toBe(false);
        });
        test("one file above the per-file cap is skipped and listed, the rest is exported", async () => {
            const result = await exportReview({ run: runCommand, cwd: repo, runDir: fresh(), base: baseSha, head: headSha, limits: { fileBytes: 1000 } });
            if (!result.ok)
                throw new Error(result.reason);
            expect(result.files.map((file) => file.path)).not.toContain("big.txt");
            expect(result.skipped).toContainEqual({ path: "big.txt", reason: expect.stringContaining("2000 bytes") });
            expect(result.files.map((file) => file.path)).toContain("a.txt");
        });
    });
});
describe("every git call", () => {
    test("starts with the shared safe global options, and the diffs keep --no-ext-diff and --no-textconv", async () => {
        const calls = [];
        const run = (cwd, command, args, timeout) => {
            if (command === "git")
                calls.push(args);
            return runCommand(cwd, command, args, timeout);
        };
        const result = await exportReview({ run, cwd: repo, runDir: mkdtempSync(join(work, "run-")), base: baseSha, head: headSha });
        expect(result.ok).toBe(true);
        expect(calls.length).toBeGreaterThanOrEqual(7);
        for (const args of calls)
            expect(args.slice(0, SAFE_GIT_ARGS.length)).toEqual([...SAFE_GIT_ARGS]);
        const diffs = calls.filter((args) => args.includes("diff"));
        expect(diffs).toHaveLength(3);
        for (const args of diffs)
            expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
    });
});
describe("a repository that configures programs or holds a submodule", () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
    /** A repository with a base commit and a head commit that changes `x.conv`. */
    const fixture = (name) => {
        const dir = join(work, name);
        mkdirSync(dir);
        gitIn(dir, "init", "-q", "-b", "main");
        writeFileSync(join(dir, "x.conv"), "raw one\n");
        gitIn(dir, "add", "-A");
        gitIn(dir, "commit", "-q", "-m", "base");
        const base = gitIn(dir, "rev-parse", "HEAD");
        writeFileSync(join(dir, "x.conv"), "raw two\n");
        return { dir, base };
    };
    test("never runs the repository's external diff program or textconv filter, so the diff is the raw one", async () => {
        const { dir, base } = fixture("hostile");
        const external = join(work, "external.sh");
        const textconv = join(work, "textconv.sh");
        const marker = join(work, "marker");
        writeExecutable(external, `#!/bin/sh\necho ran > "${marker}-external"\necho EXTERNAL-OUTPUT\n`);
        writeExecutable(textconv, `#!/bin/sh\necho ran > "${marker}-textconv"\necho CONVERTED-OUTPUT\n`);
        gitIn(dir, "config", "diff.external", external);
        gitIn(dir, "config", "diff.conv.textconv", textconv);
        writeFileSync(join(dir, ".gitattributes"), "*.conv diff=conv\n");
        gitIn(dir, "add", "-A");
        gitIn(dir, "commit", "-q", "-m", "head");
        const result = await exportReview({ run: runCommand, cwd: dir, runDir: mkdtempSync(join(work, "run-")), base, head: "main" });
        if (!result.ok)
            throw new Error(result.reason);
        const diff = read(result.dir, "round.diff");
        expect(diff).toContain("+raw two");
        expect(diff).not.toContain("EXTERNAL-OUTPUT");
        expect(diff).not.toContain("CONVERTED-OUTPUT");
        expect(existsSync(`${marker}-external`)).toBe(false);
        expect(existsSync(`${marker}-textconv`)).toBe(false);
    });
    test("skips a submodule, lists it, and exports the rest", async () => {
        const { dir, base } = fixture("withsub");
        gitIn(dir, "add", "x.conv");
        gitIn(dir, "update-index", "--add", "--cacheinfo", `160000,${base},vendor/lib`);
        gitIn(dir, "commit", "-q", "-m", "head");
        const result = await exportReview({ run: runCommand, cwd: dir, runDir: mkdtempSync(join(work, "run-")), base, head: "main" });
        if (!result.ok)
            throw new Error(result.reason);
        expect(result.skipped).toContainEqual({ path: "vendor/lib", reason: "submodule" });
        expect(result.files.map((file) => file.path)).toEqual(["x.conv"]);
    });
});
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
describe("the manifest", () => {
    test("records base, head, the diff hash recomputed from git and the SHA-256 of every exported file, and returns its own hash", async () => {
        const result = await exportReview({ run: runCommand, cwd: repo, runDir: mkdtempSync(join(work, "run-")), base: baseSha, head: headSha });
        if (!result.ok)
            throw new Error(result.reason);
        const raw = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", `${baseSha}...${headSha}`], { cwd: repo, encoding: "utf8" });
        const manifest = JSON.parse(read(result.dir, "manifest.json"));
        expect(manifest.base).toBe(baseSha);
        expect(manifest.head).toBe(headSha);
        expect(manifest.diff.sha256).toBe(sha256(raw));
        // Worked out apart from the code with `printf ... | sha256sum`.
        expect(manifest.files.find((file) => file.path === "a.txt")).toEqual({ path: "a.txt", bytes: 8, sha256: "c3f9c8c283a2b1f2f1896f27a01cbe3cddc0c9d93f752e4639035a0f5b36f6e8" });
        expect(manifest.files.find((file) => file.path === "sub/c.ts")?.sha256).toBe("6a8031b96ae809e60aaa5d4979e6b9affe087fc5fb06d770ef175a28c4c54193");
        expect(manifest.files.find((file) => file.path === ":(top)magic.txt")?.sha256).toBe("3030ce6423e63c188f5d6d742c70ba4730096865f4f166838ffa0e3a8eec4117");
        expect(manifest.files.map((file) => file.path)).toEqual(result.files.map((file) => file.path));
        expect(result.manifestHash).toBe(sha256(readFileSync(join(result.dir, "manifest.json"))));
    });
});
describe("verifyExport", () => {
    const exportInto = async (dir) => {
        const result = await exportReview({ run: runCommand, cwd: repo, runDir: dir, base: baseSha, head: headSha });
        if (!result.ok)
            throw new Error(result.reason);
        return result;
    };
    const fresh = () => exportInto(mkdtempSync(join(work, "run-")));
    test("accepts an untouched export whose manifest hash is the recorded one", async () => {
        const { dir, manifestHash } = await fresh();
        expect(verifyExport(dir, manifestHash)).toMatchObject({ ok: true, manifestHash });
    });
    test("a re-export replaces a tampered one and verifies under its new hash", async () => {
        const runDir = mkdtempSync(join(work, "run-"));
        const first = await exportInto(runDir);
        writeFileSync(join(first.dir, "files", "a.txt"), "evil\n");
        expect(verifyExport(first.dir, first.manifestHash).ok).toBe(false);
        const again = await exportInto(runDir);
        expect(again.dir).toBe(first.dir);
        expect(verifyExport(again.dir, again.manifestHash).ok).toBe(true);
    });
    // [what was done to the export, a word the refusal names]
    const tampering = [
        ["a changed file", (dir) => writeFileSync(join(dir, "files", "a.txt"), "evil\n"), "a.txt"],
        ["a changed diff", (dir) => writeFileSync(join(dir, "round.diff"), "nothing to see\n"), "round.diff"],
        ["a changed diffstat", (dir) => writeFileSync(join(dir, "diffstat.txt"), "nothing\n"), "diffstat.txt"],
        ["a changed manifest", (dir) => writeFileSync(join(dir, "manifest.json"), `${readFileSync(join(dir, "manifest.json"), "utf8")} `), "manifest"],
        ["a removed file", (dir) => rmSync(join(dir, "files", "sub", "c.ts")), "sub/c.ts"],
        ["an extra file", (dir) => writeFileSync(join(dir, "files", "new.txt"), "x"), "new.txt"],
        ["an extra file in a subdirectory", (dir) => writeFileSync(join(dir, "files", "sub", "new.txt"), "x"), "new.txt"],
        ["an extra top-level file", (dir) => writeFileSync(join(dir, "NOTES.md"), "x"), "NOTES.md"],
        ["an extra empty directory", (dir) => mkdirSync(join(dir, "files", "empty")), "empty"],
        [
            "a file replaced by a symlink to identical content",
            (dir) => {
                rmSync(join(dir, "files", "a.txt"));
                symlinkSync(join(dir, "files", "sub", "c.ts"), join(dir, "files", "a.txt"));
            },
            "a.txt",
        ],
        [
            "a subdirectory replaced by a symlink",
            (dir) => {
                renameSync(join(dir, "files", "sub"), join(dir, "sub.real"));
                symlinkSync(join(dir, "sub.real"), join(dir, "files", "sub"));
            },
            "sub",
        ],
        [
            "the diff replaced by a symlink",
            (dir) => {
                renameSync(join(dir, "round.diff"), join(dir, "files", "moved"));
                symlinkSync(join(dir, "files", "moved"), join(dir, "round.diff"));
            },
            "round.diff",
        ],
        [
            "the manifest replaced by a symlink",
            (dir) => {
                renameSync(join(dir, "manifest.json"), join(dir, "m.real"));
                symlinkSync(join(dir, "m.real"), join(dir, "manifest.json"));
            },
            "manifest",
        ],
    ];
    test.each(tampering)("refuses %s", async (_name, tamper, mention) => {
        const { dir, manifestHash } = await fresh();
        tamper(dir);
        expect(verifyExport(dir, manifestHash)).toMatchObject({ ok: false, reason: expect.stringContaining(mention) });
    });
    test("refuses a consistent rewrite of a file and the manifest, because the recorded manifest hash differs", async () => {
        const { dir, manifestHash } = await fresh();
        const manifest = JSON.parse(read(dir, "manifest.json"));
        writeFileSync(join(dir, "files", "a.txt"), "evil\n");
        const entry = manifest.files.find((file) => file.path === "a.txt");
        if (entry)
            Object.assign(entry, { bytes: 5, sha256: sha256("evil\n") });
        writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        expect(verifyExport(dir, manifestHash)).toMatchObject({ ok: false, reason: expect.stringContaining("manifest") });
    });
    test("refuses an export directory that is a symlink to the real, correctly named export", async () => {
        const { dir, manifestHash } = await fresh();
        renameSync(dir, `${dir}.real`);
        symlinkSync(`${dir}.real`, dir);
        expect(verifyExport(`${dir}.real`, manifestHash)).toMatchObject({ ok: false });
        expect(verifyExport(dir, manifestHash)).toMatchObject({ ok: false, reason: expect.stringContaining("not a plain directory") });
    });
    // A model can put anything where a file was. Each of these must be refused promptly: a FIFO must not
    // block the open, and a file far larger than recorded must be refused before it is allocated (8 GiB
    // sparse, so an unbounded read would exhaust memory rather than pass).
    const HUGE = 8 * 1024 * 1024 * 1024;
    const replaced = [
        ["manifest.json", ["manifest.json"]],
        ["round.diff", ["round.diff"]],
        ["diffstat.txt", ["diffstat.txt"]],
        ["an exported file", ["files", "a.txt"]],
    ];
    test.each(replaced)("refuses a FIFO in place of %s without blocking", async (_name, parts) => {
        const { dir, manifestHash } = await fresh();
        rmSync(join(dir, ...parts));
        execFileSync("mkfifo", [join(dir, ...parts)]);
        expect(verifyExport(dir, manifestHash)).toMatchObject({ ok: false, reason: expect.stringContaining("not a regular file") });
    });
    test.each(replaced)("refuses a file far larger than recorded in place of %s before reading it", async (_name, parts) => {
        const { dir, manifestHash } = await fresh();
        truncateSync(join(dir, ...parts), HUGE);
        expect(verifyExport(dir, manifestHash)).toMatchObject({ ok: false, reason: expect.stringContaining("larger than") });
    });
    test("a re-export over a published export whose manifest was replaced by a FIFO completes and publishes a fresh one", async () => {
        const runDir = mkdtempSync(join(work, "run-"));
        const first = await exportInto(runDir);
        rmSync(join(first.dir, "manifest.json"));
        execFileSync("mkfifo", [join(first.dir, "manifest.json")]);
        const again = await exportInto(runDir);
        expect(again.dir).toBe(first.dir);
        expect(verifyExport(again.dir, again.manifestHash).ok).toBe(true);
        expect(readdirSync(join(runDir, "review", headSha)).filter((name) => name.startsWith(".rejected-"))).toHaveLength(1);
    });
    test("refuses a missing directory and a recorded hash that is not a lowercase SHA-256", async () => {
        const { dir, manifestHash } = await fresh();
        expect(verifyExport(join(work, "nowhere"), manifestHash).ok).toBe(false);
        expect(verifyExport(dir, "not-a-hash").ok).toBe(false);
        expect(verifyExport(dir, manifestHash.toUpperCase()).ok).toBe(false);
    });
});
describe("revRefusal", () => {
    test.each(["main", "origin/main", "HEAD~3", "v1.2.0", "feat/x", "a".repeat(40), "HEAD^2", "@{upstream}"])("accepts %p", (rev) => {
        expect(revRefusal("base", rev)).toBeUndefined();
    });
});
describe("safeRepoPath", () => {
    test.each(["a.txt", "sub/c.ts", "with space/odd;name$.txt", "..hidden", "a/..b/c"])("keeps %p", (path) => {
        expect(safeRepoPath(path)).toBe(path);
    });
    test.each(["", "/etc/passwd", "../x", "a/../../x", "a/../b", "a//b", "./a", "a/./b", "a/", ".git/config", "sub/.git/hooks/x", "a\0b", "a\\..\\b"])("rejects %p", (path) => {
        expect(safeRepoPath(path)).toBeUndefined();
    });
});
