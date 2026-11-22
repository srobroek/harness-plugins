/** The run directory under the git common dir: `state.<N>.json` generations, journal.jsonl, summary.md and the `latest` link. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { JournalCorrupt, readJournal } from "./journal.ts";
import { decodeRunState } from "./state-schema.ts";
export const runCommand = (cwd, command, args, timeoutMs = 20_000, env) => new Promise((done) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => done({ ok: error === null, stdout: String(stdout), stderr: String(stderr) }));
});
/** `<git common dir>/opencode-scratch/autopilot`, or `undefined` outside a git repository. */
export async function autopilotRoot(directory, run = runCommand) {
    const result = await run(directory, "git", ["rev-parse", "--git-common-dir"]);
    if (!result.ok)
        return undefined;
    const common = result.stdout.trim();
    return join(isAbsolute(common) ? common : resolve(directory, common), "opencode-scratch", "autopilot");
}
/**
 * A run file that exists but cannot be used: `io` when reading or writing it failed, `corrupt`
 * when its content is not what the plugin wrote, `stale` when another writer moved it on or took
 * over the run lease. The underlying error, when there is one, is the `cause`.
 */
export class RunFileError extends Error {
    kind;
    path;
    constructor(kind, path, detail, cause) {
        super(`${path}: ${detail}`, cause === undefined ? undefined : { cause });
        this.kind = kind;
        this.path = path;
    }
}
const missing = (error) => error.code === "ENOENT";
const describe = (error) => (error instanceof Error ? error.message : String(error));
/** The file's text, `undefined` when it does not exist; any other failure throws. */
function readText(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch (error) {
        if (missing(error))
            return undefined;
        throw new RunFileError("io", path, describe(error), error);
    }
}
/** A state generation file: `state.<generation>.json`. */
const GENERATION_FILE = /^state\.(\d+)\.json$/;
/** How many state generations a run directory keeps; older ones are pruned after each successful write. */
export const KEEP_GENERATIONS = 5;
/**
 * A run directory. State is stored as versioned, create-exclusive files: generation `N` lives in
 * `state.<N>.json`, and the highest generation is the state. `state.json` is a symlink to the
 * latest generation for people and tools that read the directory; the plugin never reads it.
 */
export class RunDir {
    root;
    runId;
    /** The run lease owner of the transition using this directory; writes check `run.lock` still names it. */
    leaseOwner;
    constructor(root, runId) {
        this.root = root;
        this.runId = runId;
    }
    get path() {
        return join(this.root, this.runId);
    }
    /** A non-authoritative symlink to the latest generation. */
    get statePath() {
        return join(this.path, "state.json");
    }
    get journalPath() {
        return join(this.path, "journal.jsonl");
    }
    get summaryPath() {
        return join(this.path, "summary.md");
    }
    /** The cross-process lease each state transition holds, for liveness; generation files decide who wins. */
    get lockPath() {
        return join(this.path, "run.lock");
    }
    generationPath(generation) {
        return join(this.path, `state.${generation}.json`);
    }
    create() {
        mkdirSync(this.path, { recursive: true });
        if (!existsSync(this.journalPath))
            writeFileSync(this.journalPath, "");
        const link = join(this.root, "latest");
        rmSync(link, { force: true });
        symlinkSync(this.runId, link);
    }
    /** The generations on disk, ascending; empty when the run has no state yet. */
    generations() {
        let names;
        try {
            names = readdirSync(this.path);
        }
        catch (error) {
            if (missing(error))
                return [];
            throw new RunFileError("io", this.path, describe(error), error);
        }
        return names
            .map((name) => GENERATION_FILE.exec(name)?.[1])
            .filter((value) => value !== undefined)
            .map(Number)
            .sort((a, b) => a - b);
    }
    /**
     * The state: the highest generation, validated against the schema and against its file name.
     * `undefined` only when the run has no generation yet. A latest generation that cannot be read
     * or does not validate throws; an older generation never stands in for it.
     */
    readState() {
        const latest = this.generations().at(-1);
        if (latest === undefined)
            return undefined;
        const path = this.generationPath(latest);
        const text = readText(path);
        if (text === undefined)
            throw new RunFileError("io", path, "the latest state generation disappeared while it was read");
        let value;
        try {
            value = JSON.parse(text);
        }
        catch (error) {
            throw new RunFileError("corrupt", path, `not JSON (${describe(error)})`, error);
        }
        const decoded = decodeRunState(value);
        if (!decoded.ok)
            throw new RunFileError("corrupt", path, `not a run state (${decoded.reason})`);
        if (decoded.state.generation !== latest)
            throw new RunFileError("corrupt", path, `holds generation ${decoded.state.generation}`);
        return decoded.state;
    }
    /**
     * Write `next` as the generation after `read`.
     *
     * Why this cannot overwrite a newer state: the new generation is written to a temporary file of
     * its own and then hard-linked to `state.<N+1>.json`. `link` creates the name or fails with
     * EEXIST, atomically, and never replaces a file. Exactly one writer can create a generation; a
     * writer whose read is older targets a generation that already exists, so it fails. A writer
     * that stalls anywhere and resumes after its successor wrote therefore fails at the link and
     * leaves the successor's file as it was. The caller gets a `stale` error and re-reads the latest
     * state; nothing is ever replaced. The lease owner check and the up-front generation check only
     * fail a doomed write early. A write that stalled across a prune can link a pruned name below a
     * newer generation; it removes its own file and fails too.
     */
    async writeState(read, next, options = {}) {
        const expected = read?.generation;
        const latest = this.generations().at(-1);
        if (latest !== expected)
            throw new RunFileError("stale", this.path, `generation ${latest ?? "none"} on disk, this writer read ${expected ?? "nothing"}`);
        this.#checkLease(options.leaseOwner ?? this.leaseOwner);
        const generation = (expected ?? -1) + 1;
        const written = { ...next, generation };
        const target = this.generationPath(generation);
        const temporary = `${target}.tmp-${randomUUID()}`;
        try {
            try {
                writeFileSync(temporary, `${JSON.stringify(written, null, 2)}\n`, { flag: "wx" });
            }
            catch (error) {
                throw new RunFileError("io", target, describe(error), error);
            }
            await options.beforeLink?.();
            this.#checkLease(options.leaseOwner ?? this.leaseOwner);
            try {
                linkSync(temporary, target);
            }
            catch (error) {
                if (error.code === "EEXIST")
                    throw new RunFileError("stale", target, `generation ${generation} was written first by another writer`, error);
                throw new RunFileError("io", target, describe(error), error);
            }
        }
        finally {
            rmSync(temporary, { force: true });
        }
        const now = this.generations().at(-1) ?? generation;
        // The name was free only because it was never written or because it was pruned, and pruning
        // keeps the latest KEEP_GENERATIONS. A gap that wide means this write landed in the pruned range
        // below a newer state. A smaller gap means a successor already read this write and built on it.
        if (now - generation >= KEEP_GENERATIONS) {
            rmSync(target, { force: true });
            throw new RunFileError("stale", target, `generation ${generation} landed below generation ${now}`);
        }
        if (now !== generation)
            return written;
        this.#prune(generation);
        this.#pointLatest(generation);
        return written;
    }
    /** Remove generations older than the latest {@link KEEP_GENERATIONS}; called only after a successful link. */
    #prune(latest) {
        for (const generation of this.generations())
            if (generation <= latest - KEEP_GENERATIONS)
                rmSync(this.generationPath(generation), { force: true });
    }
    /** Point `state.json` at `generation` when it is still the latest. Best effort: the link is not the state. */
    #pointLatest(generation) {
        if (this.generations().at(-1) !== generation)
            return;
        const temporary = `${this.statePath}.tmp-${randomUUID()}`;
        try {
            symlinkSync(`state.${generation}.json`, temporary);
            renameSync(temporary, this.statePath);
        }
        catch {
            rmSync(temporary, { force: true });
        }
    }
    /** Throws `stale` unless `run.lock` still names `owner`; no owner means no lease to check. */
    #checkLease(owner) {
        if (owner === undefined)
            return;
        let holder;
        try {
            holder = JSON.parse(readFileSync(this.lockPath, "utf8")).owner;
        }
        catch (error) {
            throw new RunFileError("stale", this.lockPath, `the run lease cannot be read (${describe(error)})`, error);
        }
        if (holder !== owner)
            throw new RunFileError("stale", this.lockPath, `the run lease now belongs to ${String(holder)}`);
    }
    /** Append one line. A torn last line is an append that never completed: it is cut off first. */
    append(entry) {
        let fd;
        try {
            fd = openSync(this.journalPath, "a+");
        }
        catch (error) {
            throw new RunFileError("io", this.journalPath, describe(error), error);
        }
        try {
            const size = statSync(this.journalPath).size;
            if (size > 0) {
                const last = Buffer.alloc(1);
                readSync(fd, last, 0, 1, size - 1);
                if (last[0] !== 0x0a)
                    ftruncateSync(fd, this.#lastLineEnd(fd, size));
            }
            writeSync(fd, `${JSON.stringify(entry)}\n`);
        }
        catch (error) {
            throw error instanceof RunFileError ? error : new RunFileError("io", this.journalPath, describe(error), error);
        }
        finally {
            closeSync(fd);
        }
    }
    /** The offset just after the last line ending in the first `size` bytes, or 0. */
    #lastLineEnd(fd, size) {
        const buffer = Buffer.alloc(size);
        readSync(fd, buffer, 0, size, 0);
        return buffer.lastIndexOf(0x0a) + 1;
    }
    /** The journal; empty only when `journal.jsonl` does not exist. */
    journal() {
        const text = readText(this.journalPath);
        if (text === undefined)
            return [];
        try {
            return readJournal(text);
        }
        catch (error) {
            if (error instanceof JournalCorrupt)
                throw new RunFileError("corrupt", this.journalPath, error.message, error);
            throw error;
        }
    }
    writeSummary(text) {
        try {
            writeFileSync(this.summaryPath, text);
        }
        catch (error) {
            throw new RunFileError("io", this.summaryPath, describe(error), error);
        }
    }
    /** The summary; `undefined` only when `summary.md` does not exist. */
    summary() {
        return readText(this.summaryPath);
    }
}
/** The run named `runId`, or the `latest` one. */
export function findRun(root, runId) {
    let id = runId;
    if (id === undefined) {
        try {
            id = readlinkSync(join(root, "latest"));
        }
        catch (error) {
            if (missing(error))
                return undefined;
            throw new RunFileError("io", join(root, "latest"), describe(error), error);
        }
    }
    if (!/^[\w.-]+$/.test(id))
        return undefined;
    const dir = new RunDir(root, id);
    return dir.generations().length > 0 ? dir : undefined;
}
