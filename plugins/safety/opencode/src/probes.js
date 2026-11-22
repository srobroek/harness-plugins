/**
 * Bounded subprocesses for the permission gates.
 *
 * OpenCode puts no timeout on a hook, so a hung `git` or `gh` would hang the tool call.
 * Every probe one decision starts is bounded twice: by its own timeout, and by what is
 * left of one budget shared across the whole decision. Probes run asynchronously so a
 * slow repository never blocks the server's event loop.
 */
import { supervise } from "@srobroek/opencode-lib/subprocess";
/** Per subprocess. */
export const CALL_TIMEOUT_MS = 10_000;
/** For every subprocess one decision starts. */
export const DECISION_BUDGET_MS = 25_000;
/** A subprocess outlived its own timeout or the decision's budget; the message names the command. */
export class ProbeTimeout extends Error {
}
function label(argv) {
    return argv.slice(0, 3).join(" ");
}
export const spawnWithin = async (argv, cwd, timeoutMs, env) => {
    if (timeoutMs <= 0)
        throw new ProbeTimeout(label(argv));
    let child;
    try {
        child = Bun.spawn(argv, {
            cwd,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            ...(env ? { env: { ...process.env, ...env } } : {}),
        });
    }
    catch {
        return null;
    }
    const run = await supervise(child, { timeoutMs });
    if (run.kind !== "exited")
        throw new ProbeTimeout(label(argv));
    return { exitCode: run.exitCode, stdout: run.stdout };
};
export function budget(bounds = {}) {
    const timeoutMs = bounds.timeoutMs ?? CALL_TIMEOUT_MS;
    const deadline = Date.now() + (bounds.budgetMs ?? DECISION_BUDGET_MS);
    const spawn = bounds.spawn ?? spawnWithin;
    const remainingMs = () => deadline - Date.now();
    return {
        remainingMs,
        run: (argv, cwd, env) => spawn(argv, cwd, Math.min(timeoutMs, remainingMs()), env),
    };
}
/** Output of a git call, or null when it fails to start or exits non-zero. */
export async function gitOut(run, args, cwd) {
    const result = await run(["git", ...args], cwd);
    return result?.exitCode === 0 ? result.stdout : null;
}
