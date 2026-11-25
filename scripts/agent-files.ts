// Names of the files in `plugins/<name>/common/`, mostly agent files in `common/agents/`.

const CLAUDE_SUFFIX = ".claude.md"
const OMP_SUFFIX = ".omp.md"
const PI_SUFFIX = ".pi.md"

/** Suffixes for translated files and per-harness variants that must not be compiled as OpenCode source. */
export const TRANSLATED_AGENT_SUFFIXES = [CLAUDE_SUFFIX, OMP_SUFFIX, PI_SUFFIX] as const

/** The file holding an agent's Pi form; harness-kit copies it without translation. */
export const piAgentFile = (id: string) => `${id}${PI_SUFFIX}`
export const ompAgentFile = (id: string) => `${id}${OMP_SUFFIX}`

/** Whether a `common/agents/` file name holds an agent's Pi form. */
export const isPiAgentFile = (name: string) => name.endsWith(PI_SUFFIX)

/** Whether a `common/agents/` file name is a translation rather than an OpenCode agent. */
export function isTranslatedAgentFile(name: string): boolean {
  return TRANSLATED_AGENT_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * A common file's two names: plain (`x.md`), which harness-kit copies into every harness tree, and
 * its OpenCode variant (`x.opencode.md`), which only the OpenCode tree gets, under the plain name.
 */
export function openCodeForms(file: string): [plain: string, openCode: string] {
  return [file, file.replace(/(\.[^./]+)$/, ".opencode$1")]
}
