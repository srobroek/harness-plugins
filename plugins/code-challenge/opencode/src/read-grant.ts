import { realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type AgentPermission, directoryReadRules } from "@srobroek/opencode-lib/agent-files"

// The skill's references/ in the installed plugin sits outside the project, so a subagent cannot read it
// without a grant. `directoryReadRules` grants the canonical target of the path it is given, so a
// `references` that is a symlink (to its parent, or outside the plugin) would widen the grant to
// `<skill>/*` or beyond. The grant is made only when the real path is exactly `<skills root>/code-challenge/references`.
export function referenceReadRules(moduleUrl: string, warn: (message: string) => void = console.warn): AgentPermission[] {
  const skills = fileURLToPath(new URL("../skills", moduleUrl))
  const references = join(skills, "code-challenge", "references")
  try {
    const expected = join(realpathSync(skills), "code-challenge", "references")
    const actual = realpathSync(references)
    if (actual === expected) return directoryReadRules(references)
    warn(`srobroek.code-challenge: ${references} resolves to ${actual}, not ${expected}; no read grant for the references`)
  } catch (error) {
    warn(`srobroek.code-challenge: cannot resolve ${references} (${(error as NodeJS.ErrnoException).code ?? "error"}); no read grant for the references`)
  }
  return []
}
