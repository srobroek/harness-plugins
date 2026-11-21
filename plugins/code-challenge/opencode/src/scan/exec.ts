import { killChild, type SupervisedRun, supervise } from "@srobroek/opencode-lib/subprocess"
import { childEnv } from "./env.ts"

export const MAX_STDOUT_BYTES = 16 * 1024 * 1024
export const MAX_STDERR_BYTES = 1024 * 1024

/** A finished run, or the run of a tool that wrote more than its cap and was ended. */
export type ExecRun = SupervisedRun | { kind: "overflow"; stream: "stdout" | "stderr"; stdout: string; stderr: string }

export type ExecOptions = {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export type Exec = (argv: string[], options: ExecOptions) => Promise<ExecRun>

/** Forward at most `max` bytes; on the first byte past it, call `onOverflow` and end the stream. */
function bounded(source: unknown, max: number, onOverflow: () => void): unknown {
  if (!(source instanceof ReadableStream)) return source
  const reader = (source as ReadableStream<Uint8Array>).getReader()
  let total = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (chunk.done) return controller.close()
      total += chunk.value.byteLength
      if (total > max) {
        onOverflow()
        void reader.cancel().catch(() => undefined)
        return controller.close()
      }
      controller.enqueue(chunk.value)
    },
    cancel: () => reader.cancel().catch(() => undefined),
  })
}

/**
 * Run one analyzer in its own process group with an allowlisted environment, so a timeout
 * ends the tool and its children only, and bound what it can make us hold in memory.
 */
export const spawnTool: Exec = async (argv, options) => {
  const { cwd, timeoutMs, signal } = options
  try {
    const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv(), detached: true })
    const state: { overflow: "stdout" | "stderr" | null } = { overflow: null }
    const over = (stream: "stdout" | "stderr") => () => {
      state.overflow ??= stream
      killChild(child, true)
    }
    const guarded = {
      pid: child.pid,
      exited: child.exited,
      get signalCode() {
        return child.signalCode
      },
      kill: (s?: number | NodeJS.Signals) => child.kill(s),
      stdout: bounded(child.stdout, options.maxStdoutBytes ?? MAX_STDOUT_BYTES, over("stdout")),
      stderr: bounded(child.stderr, options.maxStderrBytes ?? MAX_STDERR_BYTES, over("stderr")),
    }
    const run = await supervise(guarded, { timeoutMs, signal, group: true })
    return state.overflow === null ? run : { kind: "overflow", stream: state.overflow, stdout: "", stderr: "" }
  } catch (error) {
    return { kind: "exited", exitCode: 127, signalCode: null, stdout: "", stderr: String(error) }
  }
}
