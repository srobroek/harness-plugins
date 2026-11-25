import { commandMutates, isDependencyFile } from "../../shared/report-only.ts"

export { commandMutates, isDependencyFile }

export const AGENT_ID = "whats-new"
export const APPLY_ACTION = "dep_apply"

export const DENY_REASON =
  "blocked by whats-new (report-only): this agent reports what changed between two versions and changes " +
  "nothing itself. Do not edit dependency manifests or lockfiles and do not run installers or upgrade " +
  "commands while researching; the finding belongs in the report. If the user wants the upgrade applied, " +
  "that is dep-update's job, run from another agent with its dep_scan/dep_apply loop."

export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

const MANIFEST_NAMES = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lockb", "Cargo.toml",
  "pyproject.toml", "requirements.txt", "Pipfile", "go.mod", "go.sum", "Gemfile", "composer.json",
]
const PIP_ALIASES = ["pip", "pip3", "python -m pip", "python3 -m pip"]
const MUTATING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["npm", new Set(["i", "in", "ins", "inst", "insta", "instal", "install", "isnt", "isnta", "isntal", "isntall", "add", "ci", "clean-install", "ic", "install-clean", "it", "install-test", "cit", "install-ci-test", "update", "up", "upgrade", "udpate"])],
  ["pnpm", new Set(["i", "install", "add", "update", "up", "upgrade", "it", "install-test"])],
  ["bun", new Set(["i", "install", "add", "update", "up", "upgrade"])],
  ["yarn", new Set(["install", "add", "up", "upgrade", "upgrade-interactive", "update"])],
  ["pip", new Set(["install"])], ["uv", new Set(["add", "sync"])],
  ["poetry", new Set(["add", "update", "install"])], ["cargo", new Set(["add", "install", "update"])],
  ["go", new Set(["get"])], ["bundle", new Set(["install", "update", "add"])],
  ["bundler", new Set(["install", "update", "add"])], ["gem", new Set(["install", "update"])],
  ["composer", new Set(["require", "update", "upgrade", "install"])],
])

export function reportOnlyPermissions(): PermissionRule[] {
  const rules: PermissionRule[] = []
  const deny = (action: string, resource: string) => rules.push({ action, resource, effect: "deny" })
  for (const name of MANIFEST_NAMES) {
    deny("edit", name)
    deny("edit", `*/${name}`)
  }
  deny("edit", "*.lock")
  for (const [pm, subcommands] of MUTATING) {
    for (const pmName of pm === "pip" ? PIP_ALIASES : [pm]) {
      for (const sub of subcommands) deny("shell", `${pmName} ${sub} *`)
    }
  }
  deny("shell", "yarn")
  deny("shell", "uv pip install *")
  deny("shell", "uv pip sync *")
  deny("shell", "ncu -u *")
  deny(APPLY_ACTION, "*")
  return rules
}

export type Evaluation = {
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: "allow" | "deny" | "ask"
  message?: string
}

export function decideEvaluation(evaluation: Evaluation): void {
  if (evaluation.agent !== AGENT_ID || evaluation.effect === "deny") return
  const blocked =
    evaluation.action === APPLY_ACTION ||
    (evaluation.action === "shell" && evaluation.resources.some((command) => commandMutates(command))) ||
    (evaluation.action === "edit" && evaluation.resources.some(isDependencyFile))
  if (!blocked) return
  evaluation.effect = "deny"
  evaluation.message = DENY_REASON
}
