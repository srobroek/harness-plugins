// Names of the agent files in `plugins/<name>/common/agents/`.

const CLAUDE_SUFFIX = ".claude.md"
const OMP_SUFFIX = ".omp.md"

/** Suffixes of the files scripts/build.ts translates from an OpenCode agent, one per harness that needs its own form. */
export const TRANSLATED_AGENT_SUFFIXES = [CLAUDE_SUFFIX, OMP_SUFFIX] as const

/** The file holding an agent's OMP form; harness-kit copies it to `omp/agents/<id>.md`. */
export const ompAgentFile = (id: string) => `${id}${OMP_SUFFIX}`

/** Whether a `common/agents/` file name is a translation rather than an OpenCode agent. */
export function isTranslatedAgentFile(name: string): boolean {
  return TRANSLATED_AGENT_SUFFIXES.some((suffix) => name.endsWith(suffix))
}
