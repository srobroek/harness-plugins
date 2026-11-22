/**
 * Waiting on a child process without trusting its exit event.
 *
 * Bun on macOS can lose a child's exit notification (oven-sh/bun#39709, #41024): the
 * child is gone and its pipes are closed, but `exited` never settles, and neither does
 * anything awaiting it. {@link supervise} never depends on that event alone. A deadline
 * kills the child (or its whole process group) and resolves after a grace period
 * whether or not the exit arrives, and a poll of `kill(pid, 0)` notices a child that
 * disappeared without its exit being reported.
 */
import { constants } from "node:os";
export const EXIT_GRACE_MS = 2_000;
export const EXIT_POLL_MS = 100;
/**
 * Decides, one poll at a time, that a child is gone without its exit being reported: it
 * must be seen gone for `graceMs` of wall time AND on enough consecutive polls to span
 * `graceMs`. Wall time alone is not enough: a process descheduled past the grace (a
 * loaded machine) sees the whole gap across one late poll, while the child's exit is
 * already queued behind it. Each later poll lets queued events run first.
 */
export function goneWatch(graceMs, pollMs) {
    const polls = Math.max(1, Math.ceil(graceMs / Math.max(1, pollMs)));
    let since = null;
    let seen = 0;
    return (alive) => {
        if (alive) {
            since = null;
            seen = 0;
            return false;
        }
        since ??= Date.now();
        seen++;
        return seen > polls && Date.now() - since >= graceMs;
    };
}
/** Whether a process with this pid exists (a zombie still does). */
export function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
/** SIGKILL the child's process group when it leads one, else the child. Never throws. */
export function killChild(child, group) {
    if (group) {
        try {
            process.kill(-child.pid, "SIGKILL");
            return;
        }
        catch {
            // No group left to signal; the direct child is the last thing to stop.
        }
    }
    try {
        child.kill("SIGKILL");
    }
    catch {
        // Already reaped.
    }
}
function unref(timer) {
    ;
    timer.unref?.();
}
function capture(stream) {
    if (!(stream instanceof ReadableStream))
        return { text: Promise.resolve(""), snapshot: () => "", cancel: () => { } };
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    const text = (async () => {
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                collected += decoder.decode(chunk.value, { stream: true });
            }
        }
        catch {
            // A cancelled or failed read ends the capture; the bytes already read stay.
        }
        collected += decoder.decode();
        return collected;
    })();
    const cancel = () => {
        try {
            void reader.cancel().catch(() => undefined);
        }
        catch {
            // Already released or closed.
        }
    };
    return { text, snapshot: () => collected, cancel };
}
/**
 * Collect a spawned child's piped stdout and stderr and its exit status. Never throws
 * and always settles: at the latest `graceMs` after the deadline or abort, or after the
 * child is found gone with no exit reported. Ending the run cancels the pipe readers, so
 * a descendant that inherited them cannot hold the call open either.
 *
 * Timers start synchronously, so a caller may write the child's stdin after calling this.
 */
export function supervise(child, options = {}) {
    const grace = Math.max(0, options.graceMs ?? EXIT_GRACE_MS);
    const pollMs = Math.max(1, options.pollMs ?? EXIT_POLL_MS);
    const alive = options.alive ?? processAlive;
    const group = options.group ?? false;
    const { signal, timeoutMs } = options;
    const out = capture(child.stdout);
    const err = capture(child.stderr);
    return new Promise((resolve) => {
        let ended = null;
        let exitSeen = false;
        let settled = false;
        const gone = goneWatch(grace, pollMs);
        let deadline;
        let graceTimer;
        const settle = (run) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadline);
            clearTimeout(graceTimer);
            clearInterval(poller);
            signal?.removeEventListener("abort", onAbort);
            resolve(run);
        };
        // `end` runs from raw timers and an abort listener, so every step is contained.
        const end = (cause) => {
            if (ended !== null || settled)
                return;
            ended = cause;
            // A child found gone may have had its pid reused; only its group is still worth ending.
            if (cause !== "lost" || group)
                killChild(child, group);
            out.cancel();
            err.cancel();
            graceTimer = setTimeout(() => settle({ kind: cause, stdout: out.snapshot(), stderr: err.snapshot() }), grace);
            if (options.unref)
                unref(graceTimer);
        };
        const onAbort = () => end("aborted");
        const poller = setInterval(() => {
            if (exitSeen || ended !== null || settled)
                return;
            if (gone(alive(child.pid)))
                end("lost");
        }, pollMs);
        unref(poller);
        if (timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
            deadline = setTimeout(() => end("timeout"), timeoutMs);
            if (options.unref)
                unref(deadline);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        child.exited.then(() => {
            exitSeen = true;
        }, () => undefined);
        Promise.all([child.exited, out.text, err.text]).then(([exitCode, stdout, stderr]) => {
            if (ended !== null)
                settle({ kind: ended, stdout, stderr });
            else
                settle({ kind: "exited", exitCode, signalCode: signalName(child.signalCode), stdout, stderr });
        }, () => end("lost"));
    });
}
/** Bun reports a signal by name or, since @types/bun 1.4.4, possibly by number; callers get the name. */
export function signalName(code) {
    if (code === null || code === undefined)
        return null;
    if (typeof code === "string")
        return code;
    return Object.entries(constants.signals).find(([, n]) => n === code)?.[0] ?? String(code);
}
