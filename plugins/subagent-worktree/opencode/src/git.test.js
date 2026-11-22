import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture";
import { createGit, spawnRunner } from "./git.ts";
// Real git repositories: 1.6 s at load average 49; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000);
describe("createGit().isUnborn on real repositories", () => {
    let root;
    const git = createGit(spawnRunner);
    const sh = async (cwd, ...args) => {
        const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
            stdout: "ignore",
            stderr: "ignore",
        });
        expect(await child.exited).toBe(0);
    };
    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "subagent-worktree-unborn-"));
    });
    afterAll(() => rm(root, { recursive: true, force: true }));
    test("is true after git init and false after the first commit", async () => {
        const repo = join(root, "repo");
        await sh(root, "init", "--quiet", repo);
        expect(await git.isUnborn(repo)).toBe(true);
        expect(await git.commit(repo, "HEAD")).toBeUndefined();
        await sh(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
        expect(await git.isUnborn(repo)).toBe(false);
        expect(await git.commit(repo, "HEAD")).toBeTruthy();
    });
    test("is false outside a repository", async () => {
        const plain = await mkdtemp(join(root, "plain-"));
        expect(await git.isUnborn(plain)).toBe(false);
    });
    test("trackedDirty includes staged and unstaged changes but excludes untracked files", async () => {
        const repo = await mkdtemp(join(root, "dirty-"));
        await sh(repo, "init", "--quiet");
        await writeFile(join(repo, "tracked.txt"), "first");
        await sh(repo, "add", "tracked.txt");
        await sh(repo, "commit", "--quiet", "-m", "init");
        expect(await git.trackedDirty(repo)).toBe(false);
        await writeFile(join(repo, "untracked.txt"), "new");
        expect(await git.trackedDirty(repo)).toBe(false);
        await writeFile(join(repo, "tracked.txt"), "second");
        expect(await git.trackedDirty(repo)).toBe(true);
        await sh(repo, "add", "tracked.txt");
        expect(await git.trackedDirty(repo)).toBe(true);
        await sh(repo, "commit", "--quiet", "-m", "update");
        expect(await git.trackedDirty(repo)).toBe(false);
    });
    test("trackedDirty ignores the tracked Beads export, from any subdirectory", async () => {
        const repo = await mkdtemp(join(root, "beads-"));
        await sh(repo, "init", "--quiet");
        await mkdir(join(repo, ".beads"));
        await mkdir(join(repo, "sub"));
        await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n");
        await writeFile(join(repo, "sub", "tracked.txt"), "first");
        await writeFile(join(repo, "top.txt"), "first");
        await sh(repo, "add", ".");
        await sh(repo, "commit", "--quiet", "-m", "init");
        await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n{}\n");
        expect(await git.trackedDirty(repo)).toBe(false);
        expect(await git.trackedDirty(join(repo, "sub"))).toBe(false);
        await writeFile(join(repo, "top.txt"), "second");
        expect(await git.trackedDirty(join(repo, "sub"))).toBe(true);
    });
});
describe("createGit() in a checkout with hostile config", () => {
    let root;
    const git = createGit(spawnRunner);
    const sh = async (cwd, ...args) => {
        const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
            stdout: "ignore",
            stderr: "ignore",
        });
        expect(await child.exited).toBe(0);
    };
    /** A committed repository whose `a.txt` was then rewritten with content of the same size, so git must hash it. */
    const repoWithEditedFile = async (attributes = "") => {
        const repo = await mkdtemp(join(root, "repo-"));
        await sh(repo, "init", "--quiet", "--initial-branch=main");
        if (attributes)
            await writeFile(join(repo, ".gitattributes"), attributes);
        await writeFile(join(repo, "a.txt"), "first\n");
        await sh(repo, "add", ".");
        await sh(repo, "commit", "--quiet", "-m", "init");
        await writeFile(join(repo, "a.txt"), "other\n");
        return { repo, marker: join(repo, "..", `${repo.split("/").at(-1)}.ran`) };
    };
    const ran = (marker) => Bun.file(marker).exists();
    const globalConfig = () => join(root, "global.gitconfig");
    let savedGlobal;
    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "subagent-worktree-hostile-"));
        // The user's own global config is trusted; each test writes the one it needs.
        savedGlobal = env.GIT_CONFIG_GLOBAL;
        env.GIT_CONFIG_GLOBAL = globalConfig();
        await writeFile(globalConfig(), "");
    });
    afterAll(async () => {
        if (savedGlobal === undefined)
            delete env.GIT_CONFIG_GLOBAL;
        else
            env.GIT_CONFIG_GLOBAL = savedGlobal;
        await rm(root, { recursive: true, force: true });
    });
    // Each read that compares the work tree with the index or HEAD hashes changed files, which runs clean filters.
    const reads = [
        ["status", (repo) => git.status(repo, "HEAD").then((s) => s?.dirty)],
        ["porcelain", (repo) => git.porcelain(repo).then((p) => p === undefined ? undefined : p !== "")],
        ["trackedDirty", (repo) => git.trackedDirty(repo)],
        ["localFiles", (repo) => git.localFiles(repo).then((files) => files?.includes("a.txt"))],
    ];
    test.each(reads)("%s does not run the repository's clean filter and still sees the change", async (_, read) => {
        const { repo, marker } = await repoWithEditedFile("a.txt filter=evil\n");
        await sh(repo, "config", "filter.evil.clean", `touch '${marker}'; cat`);
        await sh(repo, "config", "filter.evil.required", "true");
        expect(await read(repo)).toBe(true);
        expect(await ran(marker)).toBe(false);
    });
    test.each(reads)("%s does not run a clean filter whose driver name is empty", async (_, read) => {
        const { repo, marker } = await repoWithEditedFile("a.txt filter=\n");
        await appendFile(join(repo, ".git", "config"), `[filter ""]\n\tclean = touch '${marker}'; cat\n`);
        expect(await read(repo)).toBe(true);
        expect(await ran(marker)).toBe(false);
    });
    // A driver name that is not UTF-8 cannot be passed back to git as a `-c` key, so every read refuses.
    const refusals = [
        ["status", (repo) => git.status(repo, "HEAD")],
        ["porcelain", (repo) => git.porcelain(repo)],
        ["trackedDirty", (repo) => git.trackedDirty(repo).catch(() => undefined)],
        ["localFiles", (repo) => git.localFiles(repo)],
    ];
    test.each(refusals)("%s refuses, without running it, a filter whose driver name is not UTF-8", async (_, read) => {
        const name = Buffer.from([0xff, 0xfe]);
        const { repo, marker } = await repoWithEditedFile();
        await writeFile(join(repo, ".gitattributes"), Buffer.concat([Buffer.from("a.txt filter="), name, Buffer.from("\n")]));
        await appendFile(join(repo, ".git", "config"), Buffer.concat([Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = touch '${marker}'; cat\n`)]));
        expect(await read(repo)).toBeUndefined();
        expect(await ran(marker)).toBe(false);
    });
    test.each([
        ["a dotted, mixed-case driver name", "Ev.il", "filter.Ev.il.process"],
        ["a long-running process filter", "evil", "filter.evil.process"],
    ])("status does not run %s", async (_, driver, key) => {
        const { repo, marker } = await repoWithEditedFile(`a.txt filter=${driver}\n`);
        await sh(repo, "config", key, `touch '${marker}'; cat`);
        expect((await git.status(repo, "HEAD"))?.dirty).toBe(true);
        expect(await ran(marker)).toBe(false);
    });
    test("status does not run a clean filter that a conditional include defines", async () => {
        const { repo, marker } = await repoWithEditedFile("a.txt filter=evil\n");
        const included = join(repo, "..", `${repo.split("/").at(-1)}.inc`);
        await writeFile(included, `[filter "evil"]\n\tclean = touch '${marker}'; cat\n`);
        await sh(repo, "config", "includeIf.onbranch:main.path", included);
        expect((await git.status(repo, "HEAD"))?.dirty).toBe(true);
        expect(await ran(marker)).toBe(false);
    });
    test("status does not run a global filter driver whose program the checkout supplies", async () => {
        const { repo, marker } = await repoWithEditedFile("a.txt filter=mine\n");
        // git runs a filter from the work tree root, so a relative command is the checkout's own file.
        writeExecutable(join(repo, "clean.sh"), `#!/bin/sh\ntouch '${marker}'\ncat\n`);
        await writeFile(globalConfig(), `[filter "mine"]\n\tclean = ./clean.sh\n`);
        try {
            expect((await git.status(repo, "HEAD"))?.dirty).toBe(true);
            expect(await ran(marker)).toBe(false);
        }
        finally {
            await writeFile(globalConfig(), "");
        }
    });
    test.each([
        ["git failed to list them", { code: 128, stdout: "", stderr: "fatal: bad config line 1" }],
        ["the listing was cut off", { code: 0, stdout: "filter.evil.clean\0filter.evil.requ", stderr: "" }],
    ])("status does not run when the filter drivers cannot be read because %s", async (_, listing) => {
        const commands = [];
        const fake = createGit(async (argv) => {
            commands.push(argv);
            return argv.includes("config") ? listing : { code: 0, stdout: "", stderr: "" };
        });
        expect(await fake.status("/repo", "HEAD")).toBeUndefined();
        expect(commands.some((argv) => argv.includes("status"))).toBe(false);
    });
    test.each([
        ["the upload-pack of a local remote", "file", (other, marker) => ({
                url: other,
                config: [["remote.origin.uploadpack", `touch '${marker}'; git-upload-pack`]],
            })],
        ["an ext:: remote helper", "ext", (_, marker) => ({ url: `ext::sh -c touch% ${marker}`, config: [] })],
    ])("git never reaches %s, whatever the repository allows", async (_, protocol, remote) => {
        const { repo, marker } = await repoWithEditedFile();
        const other = await mkdtemp(join(root, "remote-"));
        await sh(other, "init", "--quiet");
        const { url, config } = remote(other, marker);
        await sh(repo, "config", `protocol.${protocol}.allow`, "always");
        await sh(repo, "remote", "add", "origin", url);
        for (const [key = "", value = ""] of config)
            await sh(repo, "config", key, value);
        expect((await spawnRunner(["git", "-C", repo, "ls-remote", "origin"])).code).not.toBe(0);
        expect(await ran(marker)).toBe(false);
    });
    test("status refuses, without running it, a filter whose driver name cannot be overridden", async () => {
        const { repo, marker } = await repoWithEditedFile("a.txt filter=a=b\n");
        await sh(repo, "config", "filter.a=b.clean", `touch '${marker}'; cat`);
        expect(await git.status(repo, "HEAD")).toBeUndefined();
        expect(await ran(marker)).toBe(false);
    });
    test("status does not run the repository's core.fsmonitor", async () => {
        const { repo, marker } = await repoWithEditedFile();
        await sh(repo, "config", "core.fsmonitor", `touch '${marker}'; false`);
        expect((await git.status(repo, "HEAD"))?.dirty).toBe(true);
        expect(await ran(marker)).toBe(false);
    });
    test("stashSubjects does not run the repository's gpg.program", async () => {
        const { repo, marker } = await repoWithEditedFile();
        const read = async (stdin, ...args) => {
            const child = Bun.spawn(["git", "-C", repo, ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "ignore" });
            expect(await child.exited).toBe(0);
            return (await new Response(child.stdout).text()).trim();
        };
        // A stash entry whose commit carries a signature, so showing it with signatures starts gpg.program.
        const tree = await read("", "write-tree");
        const head = await read("", "rev-parse", "HEAD");
        const signed = await read(`tree ${tree}\nparent ${head}\nauthor t <t@e> 1 +0000\ncommitter t <t@e> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nsigned stash\n`, "hash-object", "-t", "commit", "-w", "--stdin");
        await sh(repo, "update-ref", "--create-reflog", "-m", "On main: signed stash", "refs/stash", signed);
        const gpg = join(repo, "..", `${repo.split("/").at(-1)}.gpg`);
        writeExecutable(gpg, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
        await sh(repo, "config", "gpg.program", gpg);
        await sh(repo, "config", "log.showSignature", "true");
        expect(await git.stashSubjects(repo)).toBe("On main: signed stash");
        expect(await ran(marker)).toBe(false);
    });
    /** Run `work` with `vars` in the host environment that spawnRunner inherits, then restore it. */
    const withEnv = async (vars, work) => {
        const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, env[name]]));
        Object.assign(env, vars);
        try {
            return await work();
        }
        finally {
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined)
                    delete env[name];
                else
                    env[name] = value;
            }
        }
    };
    test.each(reads)("%s runs no repository filter when the inherited GIT_CONFIG names an empty file", async (_, read) => {
        const { repo, marker } = await repoWithEditedFile("a.txt filter=evil\n");
        await sh(repo, "config", "filter.evil.clean", `touch '${marker}'; cat`);
        const empty = join(repo, "..", `${repo.split("/").at(-1)}.empty-config`);
        await writeFile(empty, "");
        expect(await withEnv({ GIT_CONFIG: empty }, () => read(repo))).toBe(true);
        expect(await ran(marker)).toBe(false);
    });
    // A clean checkout must read as clean whatever repository, work tree or index an inherited variable names.
    test.each([
        ["GIT_DIR", async (other) => join(other, ".git")],
        ["GIT_WORK_TREE", async (other) => other],
        ["GIT_INDEX_FILE", async (other) => join(other, "missing-index")],
        ["GIT_COMMON_DIR", async (other) => join(other, ".git")],
    ])("porcelain reads the checkout's own repository when %s is inherited", async (name, value) => {
        const { repo } = await repoWithEditedFile();
        await sh(repo, "checkout", "--quiet", "--", "a.txt");
        const other = await mkdtemp(join(root, "other-"));
        await sh(other, "init", "--quiet");
        await writeFile(join(other, "b.txt"), "b\n");
        await sh(other, "add", "b.txt");
        await sh(other, "commit", "--quiet", "-m", "other");
        expect(await withEnv({ [name]: await value(other) }, () => git.porcelain(repo))).toBe("");
    });
    test("trackedDirty sees a change when GIT_LITERAL_PATHSPECS is inherited", async () => {
        const { repo } = await repoWithEditedFile();
        expect(await withEnv({ GIT_LITERAL_PATHSPECS: "1" }, () => git.trackedDirty(repo))).toBe(true);
    });
    test("porcelain writes no trace file when GIT_TRACE is inherited", async () => {
        const { repo, marker } = await repoWithEditedFile();
        await withEnv({ GIT_TRACE: marker }, () => git.porcelain(repo));
        expect(await ran(marker)).toBe(false);
    });
    test("deleteBranchAt does not run the repository's hooks", async () => {
        const { repo, marker } = await repoWithEditedFile();
        await sh(repo, "branch", "doomed");
        const oid = await git.commit(repo, "doomed");
        writeExecutable(join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`);
        expect(await git.deleteBranchAt(repo, "doomed", oid ?? "")).toBe(true);
        expect(await ran(marker)).toBe(false);
    });
});
