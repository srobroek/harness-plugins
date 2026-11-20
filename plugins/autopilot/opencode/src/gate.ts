/**
 * The fail-closed permission gate for an armed run. Pure.
 *
 * A shell request is read with the shared structural parser (`scanShell`). It is allowed only
 * when it parses completely, has no command substitution, and every simple command in it matches
 * a known safe form, with options and destinations interpreted. A command that needs a grant
 * (`--allow merge`, `--allow deploy`) or `--full` is allowed when the run has it. Everything else
 * is denied with a reason, and the caller logs that reason as a blocker:
 *
 *  - source that does not parse, or uses command substitution or a dynamic command name
 *  - a command the gate does not know, or a known command with an unknown or quoted flag
 *  - an argument the shell would expand inside a restricted command
 *  - a force push, a push to the default branch, a mirror or all-branches push, a push without
 *    an explicit branch
 */

import { type ShellWord, type SimpleCommand, scanShell } from "@srobroek/opencode-lib/shell-command"
import type { Grant } from "./args.ts"

/** What one simple command needs before the gate lets it run. */
export type Need =
  | { kind: "safe" }
  | { kind: "grant"; grant: Grant; what: string }
  | { kind: "irreversible"; what: string }
  | { kind: "never"; reason: string }
  | { kind: "unknown"; reason: string }

export type AskDecision = { effect: "allow" } | { effect: "deny"; reason: string }

const SAFE: Need = { kind: "safe" }
const unknown = (reason: string): Need => ({ kind: "unknown", reason })
const never = (reason: string): Need => ({ kind: "never", reason })
const grant = (which: Grant, what: string): Need => ({ kind: "grant", grant: which, what })
const irreversible = (what: string): Need => ({ kind: "irreversible", what })

const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(["main", "master"])

/** Tools whose arguments the gate does not interpret: they read, build, test or edit the checkout. */
const PLAIN_TOOLS: ReadonlySet<string> = new Set([
  "awk", "basename", "biome", "cat", "cd", "cmp", "cp", "cut", "date", "deno", "df", "diff", "dirname", "du",
  "echo", "eslint", "false", "fd", "file", "grep", "head", "jq", "just", "less", "ln", "ls", "make", "mkdir",
  "mv", "mypy", "node", "prettier", "printf", "pwd", "pyright", "pytest", "python", "python3", "readlink",
  "realpath", "rg", "ruff", "sed", "sort", "stat", "tail", "tee", "test", "touch", "tr", "tree", "true", "tsc",
  "type", "uniq", "wc", "which", "wt", "yq",
])

/** Package managers: dependency changes are granted; publishing is outward-facing. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["bun", "cargo", "go", "npm", "pip", "pip3", "pnpm", "uv", "yarn"])
const PUBLISHING = /^(publish|unpublish|deprecate|owner|dist-tag|yank|login|adduser|token)$/
const RELEASE_SCRIPT = /deploy|release|publish/i

/** Commands that run another command from their arguments, which the gate cannot read. */
const INDIRECT: ReadonlySet<string> = new Set([
  ".", "bash", "builtin", "command", "dash", "env", "eval", "exec", "fish", "ksh", "nohup", "sh", "source",
  "sudo", "time", "timeout", "watch", "xargs", "zsh",
])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const basename = (value: string) => value.split("/").pop() ?? value

/** A command's words as the gate reads them, with the facts it checks. */
type Args = { values: string[]; words: ShellWord[] }

function args(words: readonly ShellWord[]): Args {
  return { values: words.map((word) => word.value), words: [...words] }
}

/** The first problem with the arguments of a restricted command: a quoted flag or a shell expansion. */
function unreadable(list: Args): Need | undefined {
  for (const word of list.words) {
    if (word.expands) return unknown(`argument \`${word.value}\` is expanded by the shell`)
    if (word.quoted && word.value.startsWith("-")) return unknown(`quoted flag \`${word.value}\``)
  }
  return undefined
}

/** Short flags written together (`-fdx`) as single letters; long flags as written. */
function flagLetters(value: string): string[] {
  return value.startsWith("--") || value.length < 2 ? [value] : [...value.slice(1)].map((letter) => `-${letter}`)
}

// --- git ------------------------------------------------------------------------------------------

const GIT_GLOBAL_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])
const GIT_GLOBAL_FLAG: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"])

const GIT_READ: ReadonlySet<string> = new Set([
  "blame", "cat-file", "describe", "diff", "fetch", "for-each-ref", "grep", "log", "ls-files", "ls-remote",
  "merge-base", "name-rev", "reflog", "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status",
])
const GIT_LOCAL: ReadonlySet<string> = new Set([
  "add", "am", "apply", "cherry-pick", "commit", "init", "merge", "mv", "notes", "rebase", "remote", "revert",
  "switch", "tag",
])

function git(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const values = list.values
  let index = 0
  for (; index < values.length; index++) {
    const value = values[index] as string
    if (!value.startsWith("-")) break
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value
    if (GIT_GLOBAL_VALUE.has(name)) {
      if (!value.includes("=")) index++
      if (index >= values.length) return unknown(`git option ${value} has no value`)
      continue
    }
    if (GIT_GLOBAL_FLAG.has(value)) continue
    return unknown(`unknown git option ${value}`)
  }
  const sub = values[index]
  const rest = values.slice(index + 1)
  if (sub === undefined) return SAFE
  if (GIT_READ.has(sub) || GIT_LOCAL.has(sub)) return SAFE
  switch (sub) {
    case "push":
      return gitPush(rest)
    case "reset":
      return rest.some((value) => value === "--hard" || value === "--merge" || value === "--keep") ? irreversible("git reset discards work") : SAFE
    case "clean":
      return rest.some((value) => value === "--force" || (!value.startsWith("--") && value.startsWith("-") && value.includes("f")))
        ? irreversible("git clean deletes untracked files")
        : SAFE
    case "checkout":
      return rest.some((value) => value === "--" || value === "." || value === "-f" || value === "--force" || value === "-p" || value === "--patch")
        ? irreversible("git checkout discards changes")
        : SAFE
    case "restore":
      return rest.includes("--staged") && !rest.some((value) => value === "--worktree" || value === "-W") ? SAFE : irreversible("git restore discards changes")
    case "branch": {
      const letters = rest.flatMap(flagLetters)
      const deletes = letters.includes("-d") || letters.includes("--delete")
      const force = letters.includes("-f") || letters.includes("--force")
      if (letters.includes("-D") || letters.includes("-M") || letters.includes("-C") || (deletes && force)) return irreversible("git branch force-deletes or overwrites a branch")
      return SAFE
    }
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? irreversible("git stash drop discards a stash") : SAFE
    case "worktree":
      return rest[0] === "remove" && rest.some((value) => value === "--force" || value === "-f") ? irreversible("git worktree remove --force discards a worktree") : SAFE
    default:
      return unknown(`git ${sub} is not a command the gate knows`)
  }
}

const PUSH_FLAG: ReadonlySet<string> = new Set([
  "-u", "--set-upstream", "-n", "--dry-run", "-q", "--quiet", "-v", "--verbose", "--porcelain", "--progress",
  "--no-progress", "--atomic", "--force-with-lease", "--force-if-includes",
])
const PUSH_VALUE: ReadonlySet<string> = new Set(["-o", "--push-option"])

/** `git push <remote> <refspec>...`: explicit feature branches only. */
function gitPush(rest: readonly string[]): Need {
  const positionals: string[] = []
  let deleting = false
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index] as string
    if (value === "--") {
      positionals.push(...rest.slice(index + 1))
      break
    }
    if (!value.startsWith("-")) {
      positionals.push(value)
      continue
    }
    if (value.startsWith("--force-with-lease=")) continue
    if (value === "--force" || value === "--mirror" || value === "--all" || value === "--branches" || value === "--prune")
      return never(`git push ${value} can overwrite or delete remote branches`)
    if (value === "--delete") {
      deleting = true
      continue
    }
    if (PUSH_FLAG.has(value)) continue
    if (PUSH_VALUE.has(value)) {
      index++
      continue
    }
    if (!value.startsWith("--")) {
      const letters = flagLetters(value)
      if (letters.includes("-f")) return never("autopilot never force-pushes; use --force-with-lease on a feature branch")
      if (letters.every((letter) => letter === "-d" || PUSH_FLAG.has(letter))) {
        if (letters.includes("-d")) deleting = true
        continue
      }
    }
    return unknown(`unknown git push option ${value}`)
  }
  const [remote, ...refspecs] = positionals
  if (remote === undefined || refspecs.length === 0) return never("git push must name a remote and a branch, for example `git push origin feat/x`")
  let need: Need = SAFE
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return never("autopilot never force-pushes; a `+` refspec forces the update")
    const colon = refspec.indexOf(":")
    const source = colon < 0 ? refspec : refspec.slice(0, colon)
    const target = (colon < 0 ? refspec : refspec.slice(colon + 1)).replace(/^refs\/heads\//, "")
    if (target.includes("*")) return never(`git push refspec ${refspec} names branches by pattern`)
    if (DEFAULT_BRANCHES.has(target)) return never("autopilot never pushes to the default branch; push a feature branch and open a PR")
    if (target === "" || target === "HEAD") return never(`git push refspec ${refspec} does not name a branch`)
    if (deleting || source === "") need = irreversible(`git push deletes remote branch ${target}`)
  }
  return need
}

// --- gh and glab ----------------------------------------------------------------------------------

const GH_PR_SAFE: ReadonlySet<string> = new Set(["checks", "checkout", "comment", "create", "diff", "edit", "list", "ready", "status", "view"])
const GH_MERGE_FLAG: ReadonlySet<string> = new Set(["--squash", "-s", "--merge", "-m", "--rebase", "-r", "--delete-branch", "-d", "--auto", "--disable-auto"])
const GH_MERGE_VALUE: ReadonlySet<string> = new Set(["--subject", "-t", "--body", "-b", "--body-file", "-F", "--match-head-commit", "--repo", "-R", "--author-email", "-A"])
const GLAB_MR_SAFE: ReadonlySet<string> = new Set(["create", "diff", "list", "note", "view", "checkout"])
const GLAB_MERGE_FLAG: ReadonlySet<string> = new Set(["--squash", "-s", "--remove-source-branch", "-d", "--auto-merge", "--when-pipeline-succeeds", "--yes", "-y"])
const GLAB_MERGE_VALUE: ReadonlySet<string> = new Set(["--message", "-m", "--squash-message", "--sha", "--repo", "-R"])

/** Leading `-R owner/repo` / `--repo owner/repo`; any other leading flag is unknown. */
function skipRepo(values: readonly string[], tool: string): number | Need {
  let index = 0
  while (index < values.length && (values[index] as string).startsWith("-")) {
    const value = values[index] as string
    if (value === "-R" || value === "--repo") index += 2
    else if (value.startsWith("--repo=")) index += 1
    else return unknown(`unknown ${tool} option ${value}`)
  }
  return index > values.length ? unknown(`${tool} --repo has no value`) : index
}

function checkFlags(values: readonly string[], flags: ReadonlySet<string>, valued: ReadonlySet<string>, what: string): Need | undefined {
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as string
    if (!value.startsWith("-")) continue
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value
    if (flags.has(name)) continue
    if (valued.has(name)) {
      if (!value.includes("=")) index++
      continue
    }
    return value === "--admin" ? never(`${what} --admin bypasses branch protection`) : unknown(`unknown ${what} option ${value}`)
  }
  return undefined
}

function gh(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const start = skipRepo(list.values, "gh")
  if (typeof start !== "number") return start
  const [group, verb, ...rest] = list.values.slice(start)
  if (group === "pr" && verb === "merge") return checkFlags(rest, GH_MERGE_FLAG, GH_MERGE_VALUE, "gh pr merge") ?? grant("merge", "gh pr merge")
  if (group === "pr" && verb !== undefined && GH_PR_SAFE.has(verb)) return SAFE
  if (group === "issue" && (verb === "view" || verb === "list" || verb === "status")) return SAFE
  if (group === "run" && (verb === "view" || verb === "list" || verb === "watch")) return SAFE
  if (group === "repo" && verb === "view") return SAFE
  return unknown(`gh ${[group, verb].filter(Boolean).join(" ")} is not a command the gate knows`)
}

function glab(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const start = skipRepo(list.values, "glab")
  if (typeof start !== "number") return start
  const [group, verb, ...rest] = list.values.slice(start)
  if (group === "mr" && verb === "merge") return checkFlags(rest, GLAB_MERGE_FLAG, GLAB_MERGE_VALUE, "glab mr merge") ?? grant("merge", "glab mr merge")
  if (group === "mr" && verb !== undefined && GLAB_MR_SAFE.has(verb)) return SAFE
  if (group === "ci" && (verb === "view" || verb === "list" || verb === "status")) return SAFE
  return unknown(`glab ${[group, verb].filter(Boolean).join(" ")} is not a command the gate knows`)
}

// --- aws ------------------------------------------------------------------------------------------

const AWS_GLOBAL_VALUE: ReadonlySet<string> = new Set([
  "--region", "--profile", "--output", "--query", "--color", "--endpoint-url", "--cli-read-timeout", "--cli-connect-timeout",
])
const AWS_GLOBAL_FLAG: ReadonlySet<string> = new Set(["--no-cli-pager", "--no-paginate", "--debug"])
const AWS_READ = /^(describe|list|get|head|batch-get|lookup|search|scan|query|validate|estimate|simulate|test)-/
const CFN_DEPLOY: ReadonlySet<string> = new Set([
  "create-stack", "update-stack", "delete-stack", "deploy", "execute-change-set", "create-change-set", "delete-change-set",
  "create-stack-set", "update-stack-set", "delete-stack-set", "create-stack-instances", "update-stack-instances",
  "delete-stack-instances", "update-termination-protection", "continue-update-rollback", "rollback-stack", "cancel-update-stack",
])

function aws(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const values = list.values
  const positionals: string[] = []
  for (let index = 0; index < values.length && positionals.length < 2; index++) {
    const value = values[index] as string
    if (!value.startsWith("-")) {
      positionals.push(value)
      continue
    }
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value
    if (AWS_GLOBAL_VALUE.has(name)) {
      if (!value.includes("=")) index++
      continue
    }
    if (AWS_GLOBAL_FLAG.has(name)) continue
    return unknown(`unknown aws option ${value} before the operation`)
  }
  const [service, operation] = positionals
  if (service === undefined || operation === undefined) return unknown("aws call names no service and operation")
  if (service === "s3") return operation === "ls" ? SAFE : unknown(`aws s3 ${operation} changes S3 objects`)
  if (service === "sts" && operation === "get-caller-identity") return SAFE
  if (service === "cloudformation" && CFN_DEPLOY.has(operation)) return grant("deploy", `aws cloudformation ${operation}`)
  if (AWS_READ.test(operation)) return SAFE
  return unknown(`aws ${service} ${operation} changes AWS resources; spikes need a tag check the gate cannot make`)
}

// --- deploy tools ---------------------------------------------------------------------------------

type DeployTool = { deploy: ReadonlySet<string>; safe: ReadonlySet<string>; flags?: RegExp }
const DEPLOY_TOOLS: Record<string, DeployTool> = {
  cdk: {
    deploy: new Set(["deploy", "destroy", "import", "bootstrap", "rollback", "watch"]),
    safe: new Set(["synth", "synthesize", "diff", "ls", "list", "doctor", "docs", "notices", "context", "acknowledge"]),
  },
  sam: { deploy: new Set(["deploy", "delete", "sync", "package", "publish"]), safe: new Set(["build", "validate", "local", "list", "logs", "init"]) },
  terraform: {
    deploy: new Set(["apply", "destroy", "import", "state", "taint", "untaint", "force-unlock", "workspace", "refresh"]),
    safe: new Set(["plan", "validate", "fmt", "init", "show", "output", "providers", "version", "graph"]),
    flags: /^-chdir=/,
  },
  pulumi: {
    deploy: new Set(["up", "update", "destroy", "refresh", "import", "cancel", "state", "stack"]),
    safe: new Set(["preview", "whoami", "version", "about", "logs"]),
  },
  sst: { deploy: new Set(["deploy", "remove", "unlock"]), safe: new Set(["diff", "version"]) },
}
DEPLOY_TOOLS.tofu = DEPLOY_TOOLS.terraform as DeployTool

function deployTool(name: string, list: Args): Need {
  const tool = DEPLOY_TOOLS[name] as DeployTool
  const problem = unreadable(list)
  if (problem) return problem
  let index = 0
  while (index < list.values.length && (list.values[index] as string).startsWith("-")) {
    if (!tool.flags?.test(list.values[index] as string)) return unknown(`unknown ${name} option ${list.values[index]} before the command`)
    index++
  }
  const verb = list.values[index]
  if (verb === undefined) return SAFE
  if (tool.deploy.has(verb)) return grant("deploy", `${name} ${verb}`)
  if (tool.safe.has(verb)) return SAFE
  return unknown(`${name} ${verb} is not a command the gate knows`)
}

// --- rm, bd, find, package runners -----------------------------------------------------------------

const RM_LETTERS: ReadonlySet<string> = new Set(["-f", "-r", "-R", "-v", "-i", "-I", "-d"])
const RM_LONG: ReadonlySet<string> = new Set(["--force", "--recursive", "--verbose", "--dir", "--interactive"])

function rm(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  let recursive = false
  const targets: string[] = []
  for (let index = 0; index < list.values.length; index++) {
    const value = list.values[index] as string
    if (value === "--") {
      targets.push(...list.values.slice(index + 1))
      break
    }
    if (!value.startsWith("-") || value === "-") {
      targets.push(value)
      continue
    }
    if (value.startsWith("--")) {
      const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value
      if (!RM_LONG.has(name)) return unknown(`unknown rm option ${value}`)
      if (name === "--recursive") recursive = true
      continue
    }
    for (const letter of flagLetters(value)) {
      if (!RM_LETTERS.has(letter)) return unknown(`unknown rm option ${value}`)
      if (letter === "-r" || letter === "-R") recursive = true
    }
  }
  if (targets.some((target) => /^\/+$/.test(target) || target === "." || target === ".." || /^\.\.?\/*$/.test(target)))
    return never("rm of the root, the current or the parent directory")
  return recursive ? irreversible("rm -r deletes directories") : SAFE
}

const BD_FLAG: ReadonlySet<string> = new Set(["--json", "--quiet", "-q", "--verbose", "-v", "--global", "--readonly", "--sandbox", "--no-daemon"])
const BD_VALUE: ReadonlySet<string> = new Set(["--db", "--actor", "--directory", "-C"])
const BD_IRREVERSIBLE: ReadonlySet<string> = new Set(["delete", "purge"])
const BD_UNKNOWN: ReadonlySet<string> = new Set(["admin", "compact", "migrate", "rename-prefix", "reset", "sql"])

function bd(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  let index = 0
  for (; index < list.values.length; index++) {
    const value = list.values[index] as string
    if (!value.startsWith("-")) break
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value
    if (BD_FLAG.has(name)) continue
    if (BD_VALUE.has(name)) {
      if (!value.includes("=")) index++
      continue
    }
    return unknown(`unknown bd option ${value} before the command`)
  }
  const verb = list.values[index]
  if (verb !== undefined && BD_IRREVERSIBLE.has(verb)) return irreversible(`bd ${verb} removes beads`)
  if (verb !== undefined && BD_UNKNOWN.has(verb)) return unknown(`bd ${verb} is not a command the gate knows`)
  return SAFE
}

const FIND_RUNS = /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/

function find(list: Args): Need {
  const runs = list.values.find((value) => FIND_RUNS.test(value))
  return runs ? unknown(`find ${runs} deletes files or runs commands`) : SAFE
}

/** `npx [-y] <package> ...`: a known gated package is classified as itself; any other package is unknown. */
function packageRunner(runner: string, list: Args): Need {
  let index = 0
  while (index < list.values.length && /^(-y|--yes|--no|-q|--quiet)$/.test(list.values[index] as string)) index++
  const pkg = list.values[index]
  if (pkg === undefined) return unknown(`${runner} names no package`)
  if (list.words[index]?.quoted || list.words[index]?.expands) return unknown(`${runner} package name is quoted or expanded`)
  const name = basename(pkg.replace(/(?<=.)@[^/]*$/, "")).replace(/^aws-cdk$/, "cdk")
  const rest = args(list.words.slice(index + 1))
  if (name in DEPLOY_TOOLS) return deployTool(name, rest)
  if (PLAIN_TOOLS.has(name)) return SAFE
  return unknown(`${runner} ${pkg} runs a package the gate does not know`)
}

function packageManager(name: string, list: Args): Need {
  const [verb, script] = list.values
  if (verb === undefined) return SAFE
  if (name === "bun" && verb === "x") return packageRunner("bun x", args(list.words.slice(1)))
  if (PUBLISHING.test(verb)) return unknown(`${name} ${verb} is outward-facing`)
  if ((verb === "run" || verb === "run-script") && script !== undefined && RELEASE_SCRIPT.test(script)) return unknown(`${name} run ${script} looks like a release script`)
  return SAFE
}

// --- dispatch -------------------------------------------------------------------------------------

/** What one simple command needs. */
export function classifyCommand(command: SimpleCommand): Need {
  const words = command.words
  let index = 0
  while (index < words.length && !(words[index] as ShellWord).quoted && ASSIGNMENT.test((words[index] as ShellWord).value)) index++
  const head = words[index]
  if (head === undefined) return SAFE
  if (head.quoted || head.expands) return unknown(`command name \`${head.value}\` is quoted or expanded`)
  const name = basename(head.value)
  const rest = args(words.slice(index + 1))
  if (INDIRECT.has(name)) return unknown(`${name} runs a command the gate cannot read`)
  switch (name) {
    case "git":
      return git(rest)
    case "gh":
      return gh(rest)
    case "glab":
      return glab(rest)
    case "aws":
      return aws(rest)
    case "rm":
      return rm(rest)
    case "bd":
      return bd(rest)
    case "find":
      return find(rest)
    case "npx":
    case "bunx":
    case "pnpx":
      return packageRunner(name, rest)
  }
  if (name in DEPLOY_TOOLS) return deployTool(name, rest)
  if (PACKAGE_MANAGERS.has(name)) return packageManager(name, rest)
  if (PLAIN_TOOLS.has(name)) return SAFE
  return unknown(`${name} is not a command the gate knows`)
}

/** What a shell source needs, one entry per simple command; one `unknown` when it cannot be read. */
export function classifyShell(source: string): Need[] {
  const scan = scanShell(source)
  if (!scan.complete) return [unknown("the command does not parse: a quote, substitution or here-document is left open")]
  if (scan.substitutions.length > 0) return [unknown("the command uses command substitution, which the gate cannot read")]
  const needs = scan.items.flatMap((item) => (item.kind === "command" ? [classifyCommand(item)] : []))
  return needs.length > 0 ? needs : [unknown("the command is empty")]
}

const SHELL_ACTIONS: ReadonlySet<string> = new Set(["shell", "bash"])

/** What a permission request needs: shell requests by their commands, merge tools by name. */
export function needsOf(action: string, resources: readonly string[]): Need[] {
  const name = action.toLowerCase()
  if (SHELL_ACTIONS.has(name)) return resources.length > 0 ? resources.flatMap(classifyShell) : [unknown("the shell request names no command")]
  if (name === "delivery_land" || name.endsWith("_merge")) return [grant("merge", action)]
  return [SAFE]
}

/** The first need the run does not meet, as a deny reason, or `undefined` when all are met. */
function unmet(need: Need, grants: readonly Grant[], full: boolean): string | undefined {
  switch (need.kind) {
    case "safe":
      return undefined
    case "grant":
      return grants.includes(need.grant) ? undefined : `${need.what} needs --allow ${need.grant}, which this run does not have; logged as a blocker`
    case "irreversible":
      return full ? undefined : `irreversible command parked: ${need.what}; logged as a blocker (a --full run decides it)`
    case "never":
      return need.reason
    case "unknown":
      return `autopilot allows only commands it can read: ${need.reason}; logged as a blocker`
  }
}

/**
 * The answer to a permission `ask` while armed. Fail-closed: every command in the request must
 * be a known safe form, or need only grants the run has.
 */
export function decideAsk(action: string, resources: readonly string[], grants: readonly Grant[], full: boolean): AskDecision {
  for (const need of needsOf(action, resources)) {
    const reason = unmet(need, grants, full)
    if (reason !== undefined) return { effect: "deny", reason }
  }
  return { effect: "allow" }
}
