/**
 * A subagent cannot answer an `external_directory` prompt, so the ask would become a deny and a reviewer
 * could not read a clone outside its worktree. Reading is what these agents are for: this turns the ask
 * into an allow for the read-only tools and the shell, since an agent that has a shell can `cat` the path
 * anyway. Writers (`edit`, `write`, `patch`) keep the ask, and so does any secret location.
 */

import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { inside, resolved } from "./scratch-dirs.ts"
import { READ_ONLY_TOOLS } from "./skill-references.ts"

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string }

/** Tools that run commands; the shell can read any path the user can. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell", "bash"])

/** Where credentials live. A request below one of these, or for a folder that contains one, stays an ask. */
export const SECRET_LOCATIONS: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/op",
  "~/.config/gh/hosts.yml",
  "~/.netrc",
  "~/.docker/config.json",
  "~/.kube",
  "~/.local/share/opencode/auth.json",
]

/** `*.env` and `*.env.*` paths hold secrets wherever they are. */
const ENV_FILE = /\.env(\.|$)/

function expand(location: string, home: string): string {
  return location === "~" || location.startsWith("~/") ? join(home, location.slice(1)) : location
}

/**
 * Whether `resource` (an absolute path or a `dir/*` pattern) overlaps a secret. A wildcard anywhere but
 * the end, a `..` segment or a relative path cannot be judged, so it counts as secret. The path is resolved
 * through symlinks first, and every check runs on the canonical path (and on the given name for `.env`
 * files), so a harmless-looking link to a secret is caught. Overlap works both ways: a request for a
 * folder that contains a secret (`~/*`, `~/.config/*`) counts too, since allowing it would expose the secret.
 */
export function isSecretResource(resource: string, extra: readonly string[] = [], home: string = homedir()): boolean {
  const expanded = expand(resource, home)
  if (!isAbsolute(expanded)) return true
  const path = expanded.replace(/\/\*{1,2}$/, "") || "/"
  if (/[*?[\]{}]/.test(path) || path.split("/").includes("..")) return true
  const real = resolved(path)
  if (ENV_FILE.test(basename(path)) || ENV_FILE.test(basename(real))) return true
  return [...SECRET_LOCATIONS, ...extra].some((location) => {
    const root = resolved(expand(location, home))
    return inside(real, [root]) || inside(root, [real])
  })
}

/**
 * In a subagent session (`isSubagent`), turn an `external_directory` ask into an allow when `tool` is
 * read-only or the shell and no resource is a secret. Everything else is left alone.
 */
export function allowSubagentReads(
  evaluation: Evaluation,
  tool: string | undefined,
  isSubagent: boolean,
  extraSecrets: readonly string[] = [],
  home?: string,
): void {
  if (!isSubagent || evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
  if (tool === undefined || !(READ_ONLY_TOOLS.has(tool) || SHELL_TOOLS.has(tool))) return
  if (evaluation.resources.length === 0) return
  if (evaluation.resources.some((resource) => isSecretResource(resource, extraSecrets, home))) return
  evaluation.effect = "allow"
}
