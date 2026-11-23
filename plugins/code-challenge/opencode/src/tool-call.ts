// The host-neutral contract of the four code-challenge tools. Each tool's handler takes its raw
// input and a ToolCall and returns a ToolOutcome; the OpenCode plugin (index.ts) and the OMP
// extension (omp-src/index.ts) only adapt their host's call context and result shape to it.

/** A tool result: the text the model reads and the metadata the host keeps beside it. */
export type ToolOutcome = { content: string; metadata: Record<string, unknown> }

/** What a handler needs from its host for one call. */
export type ToolCall = {
  /** The invoking session's directory; read only when the input needs it, so a bad input fails first. */
  directory: () => Promise<string>
  signal?: AbortSignal
}
