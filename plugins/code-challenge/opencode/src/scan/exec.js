import { killChild, supervise } from "@srobroek/opencode-lib/subprocess";
import { childEnv } from "./env.ts";
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 1024 * 1024;
/** Forward at most `max` bytes; on the first byte past it, call `onOverflow` and end the stream. */
function bounded(source, max, onOverflow) {
    if (!(source instanceof ReadableStream))
        return source;
    const reader = source.getReader();
    let total = 0;
    return new ReadableStream({
        async pull(controller) {
            const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
            if (chunk.done)
                return controller.close();
            total += chunk.value.byteLength;
            if (total > max) {
                onOverflow();
                void reader.cancel().catch(() => undefined);
                return controller.close();
            }
            controller.enqueue(chunk.value);
        },
        cancel: () => reader.cancel().catch(() => undefined),
    });
}
/**
 * Run one analyzer in its own process group with an allowlisted environment, so a timeout
 * ends the tool and its children only, and bound what it can make us hold in memory.
 */
export const spawnTool = async (argv, options) => {
    const { cwd, timeoutMs, signal } = options;
    try {
        const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv(), detached: true });
        const state = { overflow: null };
        const over = (stream) => () => {
            state.overflow ??= stream;
            killChild(child, true);
        };
        const guarded = {
            pid: child.pid,
            exited: child.exited,
            get signalCode() {
                return child.signalCode;
            },
            kill: (s) => child.kill(s),
            stdout: bounded(child.stdout, options.maxStdoutBytes ?? MAX_STDOUT_BYTES, over("stdout")),
            stderr: bounded(child.stderr, options.maxStderrBytes ?? MAX_STDERR_BYTES, over("stderr")),
        };
        const run = await supervise(guarded, { timeoutMs, signal, group: true });
        return state.overflow === null ? run : { kind: "overflow", stream: state.overflow, stdout: "", stderr: "" };
    }
    catch (error) {
        return { kind: "exited", exitCode: 127, signalCode: null, stdout: "", stderr: String(error) };
    }
};
