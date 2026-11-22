import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, exited, fakeExec, pythonRepo, RUFF_HIT, temp, withTools } from "./fixtures.ts";
import { runScan } from "./run.ts";
afterAll(cleanup);
function gitRepoFixture() {
    const root = pythonRepo();
    const gitDir = join(temp(), ".git");
    mkdirSync(gitDir);
    const exec = fakeExec({ "rev-parse": exited(gitDir), "check --isolated": exited(RUFF_HIT, 1), "--show-settings": exited("") });
    return { root, gitDir, exec, which: withTools("ruff", "git") };
}
describe("output directories", () => {
    test("are created private, one real directory per segment", async () => {
        const { root, gitDir, exec, which } = gitRepoFixture();
        const report = await runScan({ root, languages: ["python"], runId: "r1" }, { exec, which });
        expect(report.rawDir).toBe(join(gitDir, "code-challenge", "r1", "scan"));
        expect(statSync(report.rawDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(report.rawDir, "ruff_lenses.stdout")).mode & 0o777).toBe(0o600);
    });
    test("a symlinked code-challenge directory is refused and nothing lands behind it", async () => {
        const { root, gitDir, exec, which } = gitRepoFixture();
        const elsewhere = temp();
        symlinkSync(elsewhere, join(gitDir, "code-challenge"));
        await expect(runScan({ root, languages: ["python"], runId: "r1" }, { exec, which })).rejects.toThrow(/not a real directory/);
        expect(() => statSync(join(elsewhere, "r1"))).toThrow();
    });
    test("a planted symlink at an output file is not followed", async () => {
        const { root, gitDir, exec, which } = gitRepoFixture();
        const raw = join(gitDir, "code-challenge", "r1", "scan");
        mkdirSync(raw, { recursive: true });
        const victim = join(temp(), "victim.txt");
        writeFileSync(victim, "precious");
        symlinkSync(victim, join(raw, "ruff_lenses.stdout"));
        await expect(runScan({ root, languages: ["python"], runId: "r1" }, { exec, which })).rejects.toThrow();
        expect(readFileSync(victim, "utf8")).toBe("precious");
    });
    test("a second run with the same id overwrites its own outputs", async () => {
        const { root, exec, which } = gitRepoFixture();
        await runScan({ root, languages: ["python"], runId: "r1" }, { exec, which });
        const again = await runScan({ root, languages: ["python"], runId: "r1" }, { exec, which });
        expect(readFileSync(join(again.rawDir, "ruff_lenses.stdout"), "utf8")).toBe(RUFF_HIT);
    });
});
