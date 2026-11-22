import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunDir, RunFileError } from "./rundir.ts";
import { newRunState } from "./state.ts";
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
function runDir(id) {
    const root = mkdtempSync(join(tmpdir(), "autopilot-rundir-"));
    roots.push(root);
    const dir = new RunDir(root, id);
    dir.create();
    return dir;
}
const fresh = (id) => newRunState({ runId: id, sessionID: "s", directory: "/repo", options: {}, scope: { kind: "queue" }, now: 0 });
const stateFiles = (dir) => readdirSync(dir.path)
    .filter((name) => /^state\.\d+\.json$/.test(name))
    .sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
const outcome = (write) => write.then(() => "written", (error) => (error instanceof RunFileError ? error.kind : "other"));
test("an entry appended after a torn last line still reads back", () => {
    const dir = runDir("r1");
    dir.append({ ts: "t", type: "progress", summary: "a" });
    appendFileSync(dir.journalPath, '{"ts":"t","ty');
    dir.append({ ts: "t", type: "progress", summary: "b" });
    expect(dir.journal().map((entry) => entry.summary)).toEqual(["a", "b"]);
});
test("a writer holding an older read is refused", async () => {
    const dir = runDir("r3");
    const first = await dir.writeState(undefined, fresh("r3"));
    const stale = dir.readState();
    await dir.writeState(first, { ...first, phase: "stopped" });
    await expect(dir.writeState(stale, { ...stale, phase: "running" })).rejects.toThrow(RunFileError);
    expect(dir.readState()?.phase).toBe("stopped");
});
test("a stalled writer that resumes after its successor wrote fails, and the successor's state is intact", async () => {
    const dir = runDir("r4");
    const first = await dir.writeState(undefined, fresh("r4"));
    let resume = () => { };
    const paused = new Promise((resolve) => {
        resume = resolve;
    });
    let reached = () => { };
    const atLink = new Promise((resolve) => {
        reached = resolve;
    });
    const stalled = outcome(dir.writeState(first, { ...first, ticks: 1 }, {
        beforeLink: async () => {
            reached();
            await paused;
        },
    }));
    await atLink;
    // The successor read the same generation and writes while the first writer is stalled.
    expect(await outcome(dir.writeState(first, { ...first, phase: "stopped", ticks: 2 }))).toBe("written");
    resume();
    expect(await stalled).toBe("stale");
    expect(dir.readState()).toMatchObject({ generation: 1, phase: "stopped", ticks: 2 });
});
test("of two concurrent writers of the same generation, exactly one wins", async () => {
    const dir = runDir("r5");
    const first = await dir.writeState(undefined, fresh("r5"));
    const results = await Promise.all([outcome(dir.writeState(first, { ...first, ticks: 1 })), outcome(dir.writeState(first, { ...first, ticks: 2 }))]);
    expect([...results].sort()).toEqual(["stale", "written"]);
    expect(dir.readState()?.ticks).toBe(results[0] === "written" ? 1 : 2);
    expect(stateFiles(dir)).toEqual(["state.0.json", "state.1.json"]);
});
test("a corrupt latest generation is an error, never skipped for an older one", async () => {
    const dir = runDir("r6");
    const first = await dir.writeState(undefined, fresh("r6"));
    await dir.writeState(first, { ...first, ticks: 1 });
    writeFileSync(join(dir.path, "state.1.json"), "{ torn");
    expect(() => dir.readState()).toThrow(RunFileError);
});
test("keeps only the latest five generations", async () => {
    const dir = runDir("r7");
    let state = await dir.writeState(undefined, fresh("r7"));
    for (let index = 1; index < 8; index++)
        state = await dir.writeState(state, { ...state, ticks: index });
    expect(stateFiles(dir)).toEqual(["state.3.json", "state.4.json", "state.5.json", "state.6.json", "state.7.json"]);
    expect(dir.readState()).toMatchObject({ generation: 7, ticks: 7 });
    expect(JSON.parse(readFileSync(dir.statePath, "utf8"))).toMatchObject({ generation: 7 });
});
test("a writer that stalls across a prune and links a pruned name fails and removes its file", async () => {
    const dir = runDir("r10");
    const first = await dir.writeState(undefined, fresh("r10"));
    let resume = () => { };
    const paused = new Promise((resolve) => {
        resume = resolve;
    });
    let reached = () => { };
    const atLink = new Promise((resolve) => {
        reached = resolve;
    });
    const stalled = outcome(dir.writeState(first, { ...first, ticks: 99 }, {
        beforeLink: async () => {
            reached();
            await paused;
        },
    }));
    await atLink;
    let state = first;
    for (let index = 1; index <= 6; index++)
        state = await dir.writeState(state, { ...state, ticks: index });
    expect(stateFiles(dir)).toEqual(["state.2.json", "state.3.json", "state.4.json", "state.5.json", "state.6.json"]);
    resume();
    expect(await stalled).toBe("stale");
    expect(stateFiles(dir)).toEqual(["state.2.json", "state.3.json", "state.4.json", "state.5.json", "state.6.json"]);
    expect(dir.readState()).toMatchObject({ generation: 6, ticks: 6 });
});
test("a writer whose run lease another owner took over is refused before it links", async () => {
    const dir = runDir("r8");
    const first = await dir.writeState(undefined, fresh("r8"));
    writeFileSync(dir.lockPath, JSON.stringify({ host: "h", pid: 1, owner: "successor", token: "t", taken: 0, expires: 0 }));
    await expect(dir.writeState(first, { ...first, ticks: 1 }, { leaseOwner: "me" })).rejects.toThrow(/lease/);
    expect(dir.readState()?.ticks).toBe(0);
});
test("append reports a journal it cannot read instead of guessing", () => {
    const dir = runDir("r2");
    dir.append({ ts: "t", type: "progress", summary: "a" });
    chmodSync(dir.journalPath, 0o200);
    try {
        expect(() => dir.append({ ts: "t", type: "progress", summary: "b" })).toThrow(/EACCES/);
    }
    finally {
        chmodSync(dir.journalPath, 0o600);
    }
});
test("a run file error keeps the error it wraps as its cause", async () => {
    const dir = runDir("r9");
    await dir.writeState(undefined, fresh("r9"));
    const latest = join(dir.path, "state.0.json");
    chmodSync(latest, 0o200);
    try {
        let caught;
        try {
            dir.readState();
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(RunFileError);
        expect(caught.cause.code).toBe("EACCES");
    }
    finally {
        chmodSync(latest, 0o600);
    }
});
