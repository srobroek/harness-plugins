import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Shared fixtures for the scan tests: temp repos, canned analyzer runs and a recording fake exec. */
const dirs = [];
export function temp() {
    const dir = mkdtempSync(join(tmpdir(), "challenge-scan-"));
    dirs.push(dir);
    return dir;
}
export function cleanup() {
    for (const dir of dirs)
        rmSync(dir, { recursive: true, force: true });
}
export const exited = (stdout, exitCode = 0, stderr = "") => ({
    kind: "exited",
    exitCode,
    signalCode: null,
    stdout,
    stderr,
});
export const RUFF_HIT = JSON.stringify([
    { code: "PERF401", filename: "a.py", location: { row: 5 }, message: "use a list comprehension" },
    { code: "T201", filename: "a.py", location: { row: 9 }, message: "print found" },
]);
export function pythonRepo() {
    const root = temp();
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname='x'\n");
    writeFileSync(join(root, "a.py"), "print(1)\n");
    return root;
}
/** A fake exec answering by a fragment of the tool's argv; records every call. */
export function fakeExec(answers, calls = []) {
    return async (argv, options) => {
        calls.push({ argv, options });
        const key = Object.keys(answers).find((k) => argv.join(" ").includes(k));
        if (key)
            return answers[key];
        // Unless a test says otherwise the target is not a git repository.
        if (argv.includes("rev-parse"))
            return exited("", 128, "fatal: not a git repository (or any of the parent directories): .git");
        return exited("", 0);
    };
}
export const withTools = (...names) => (binary) => names.includes(binary) ? `/bin/${binary}` : null;
