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

/** Tools whose arguments the gate does not interpret: they read the checkout, or check it with the repository's own config. */
const PLAIN_TOOLS: ReadonlySet<string> = new Set([
  "basename", "biome", "cat", "cd", "cmp", "cp", "cut", "date", "df", "diff", "dirname", "du", "echo", "eslint",
  "false", "fd", "file", "grep", "head", "jq", "less", "ln", "ls", "mkdir", "mv", "mypy", "prettier", "printf",
  "pwd", "pyright", "pytest", "readlink", "realpath", "rg", "ruff", "sort", "stat", "tail", "tee", "test", "touch",
  "tr", "tree", "true", "tsc", "type", "uniq", "wc", "which",
])

const RELEASE_SCRIPT = /deploy|release|publish/i

/**
 * Commands that run code the gate cannot read. Interpreters (`python`, `node`, `deno`, `awk`,
 * `sed`, ...) and package executors (`npx`, `bunx`, `uvx`, `pipx`, ...) are denied unless a
 * handler below matches a known safe form, such as `python3 -m pytest` or `npm run <script>`.
 */
const INDIRECT: ReadonlySet<string> = new Set([
  ".", "awk", "bash", "builtin", "command", "dash", "env", "eval", "exec", "fish", "gawk", "ksh", "mawk", "nohup",
  "perl", "php", "pipx", "pnpx", "ruby", "sed", "sh", "source", "sudo", "time", "timeout", "uvx", "watch", "xargs", "zsh",
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

/** Push destinations' default branches, by remote name, as the caller resolved them. */
export type DefaultBranches = ReadonlyMap<string, string>

/** What the gate knows about the run and the repository when it decides. */
export type GateContext = { grants: readonly Grant[]; full: boolean; defaults: DefaultBranches }

const NO_DEFAULTS: DefaultBranches = new Map()

// --- git ------------------------------------------------------------------------------------------

/** `-c` is not here: a config value such as `core.pager` or `core.sshCommand` runs a command. */
const GIT_GLOBAL_VALUE: ReadonlySet<string> = new Set(["-C", "--git-dir", "--work-tree", "--namespace"])
const GIT_GLOBAL_FLAG: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"])
/** Options that make a git subcommand run a command from their value. */
const GIT_RUNS = /^--(upload-pack|receive-pack|exec|exec-path|ext-diff)(=|$)/

const GIT_READ: ReadonlySet<string> = new Set([
  "blame", "cat-file", "describe", "diff", "fetch", "for-each-ref", "grep", "log", "ls-files", "ls-remote",
  "merge-base", "name-rev", "reflog", "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status",
])
const GIT_LOCAL: ReadonlySet<string> = new Set(["add", "am", "apply", "cherry-pick", "commit", "init", "merge", "mv", "notes", "remote", "revert", "tag"])

function git(list: Args, context: GateContext): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const values = list.values
  let index = 0
  let elsewhere = false
  for (; index < values.length; index++) {
    const value = values[index] as string
    if (!value.startsWith("-")) break
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value
    if (name === "-c") return unknown("git -c can run a command through a config value")
    if (GIT_GLOBAL_VALUE.has(name)) {
      elsewhere = true
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
  const runs = rest.find((value) => GIT_RUNS.test(value))
  if (runs !== undefined) return unknown(`git ${sub} ${runs} runs a command`)
  if (GIT_READ.has(sub) || GIT_LOCAL.has(sub)) return SAFE
  const letters = rest.flatMap(flagLetters)
  switch (sub) {
    case "push":
      return elsewhere ? never("git push with -C, --git-dir or --work-tree pushes from a repository the gate did not check") : gitPush(rest, context)
    case "rebase":
      return letters.includes("-x") ? unknown("git rebase -x runs a command") : SAFE
    case "reset":
      return rest.some((value) => value === "--hard" || value === "--merge" || value === "--keep") ? irreversible("git reset discards work") : SAFE
    case "clean":
      return rest.some((value) => value === "--force" || (!value.startsWith("--") && value.startsWith("-") && value.includes("f")))
        ? irreversible("git clean deletes untracked files")
        : SAFE
    case "switch":
      return rest.some((value) => value === "--discard-changes" || value === "--force" || value === "--force-create") || letters.includes("-f") || letters.includes("-C")
        ? irreversible("git switch discards changes or resets a branch")
        : SAFE
    case "checkout":
      // `git checkout <name>` cannot be told apart from `git checkout <path>`, which discards changes;
      // only creating a branch is a known safe form. Use `git switch` to change branches.
      return rest[0] === "-b" && rest.length >= 2 && rest.length <= 3 && rest.slice(1).every((value) => !value.startsWith("-") && value !== ".")
        ? SAFE
        : irreversible("git checkout can discard changes; use git switch")
    case "restore":
      return rest.includes("--staged") && !rest.some((value) => value === "--worktree" || value === "-W") ? SAFE : irreversible("git restore discards changes")
    case "branch": {
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

/**
 * `git push <remote> <refspec>...`: explicit feature branches only. `main`, `master` and the
 * remote's own default branch, as resolved by the caller, are never a target; a remote whose
 * default branch is unknown cannot be pushed to.
 */
function gitPush(rest: readonly string[], context: GateContext): Need {
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
  const remoteDefault = context.defaults.get(remote)
  if (remoteDefault === undefined) return never(`the default branch of remote ${remote} could not be resolved, so the push is denied`)
  let need: Need = SAFE
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return never("autopilot never force-pushes; a `+` refspec forces the update")
    const colon = refspec.indexOf(":")
    const source = colon < 0 ? refspec : refspec.slice(0, colon)
    const target = (colon < 0 ? refspec : refspec.slice(colon + 1)).replace(/^refs\/heads\//, "")
    if (target.includes("*")) return never(`git push refspec ${refspec} names branches by pattern`)
    if (DEFAULT_BRANCHES.has(target) || target === remoteDefault)
      return never(`autopilot never pushes to the default branch (${remote}/${remoteDefault}); push a feature branch and open a PR`)
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

// --- package managers, script runners and interpreters ---------------------------------------------
//
// The rule: the gate allows the repository's own scripts and test runners by name
// (`npm test`, `npm run <script>`, `bun test`, `make <target>`, `python3 -m pytest`, ...), and
// dependency changes. It denies running a file, an inline program (`-c`, `-e`), a package
// executor (`npx`, `npm exec`, `pnpm dlx`, `bunx`, `uvx`, ...) and a script or target whose name
// looks like a release. The one executor form it reads is `npx cdk ...`, classified as `cdk`.

const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]*$/

/** `<runner> run <script>` / `<runner> <script>`: a script name of the repository, not a path or release. */
function script(runner: string, name: string | undefined): Need {
  if (name === undefined) return unknown(`${runner} run names no script`)
  if (!SCRIPT_NAME.test(name) || name.includes("/")) return unknown(`${runner} runs \`${name}\`, which is not a script name`)
  if (RELEASE_SCRIPT.test(name)) return unknown(`${runner} script ${name} looks like a release`)
  return SAFE
}

type Verbs = { deps: ReadonlySet<string>; read: ReadonlySet<string>; tests: ReadonlySet<string>; run: ReadonlySet<string> }
const verbs = (deps: string[], read: string[], tests: string[], run: string[]): Verbs => ({ deps: new Set(deps), read: new Set(read), tests: new Set(tests), run: new Set(run) })

const JS_RUNNERS: Record<string, Verbs> = {
  npm: verbs(["install", "i", "ci", "add", "uninstall", "remove", "rm", "update", "up", "dedupe", "prune"], ["ls", "list", "outdated", "audit", "view", "info", "why", "explain", "config", "root", "bin", "prefix"], ["test", "t"], ["run", "run-script"]),
  pnpm: verbs(["install", "i", "add", "remove", "rm", "update", "up", "prune"], ["ls", "list", "outdated", "audit", "why", "root"], ["test", "t"], ["run"]),
  yarn: verbs(["install", "add", "remove", "up", "upgrade"], ["list", "info", "why", "outdated"], ["test"], ["run"]),
  bun: verbs(["install", "i", "add", "remove", "rm", "update", "pm"], ["outdated", "audit"], ["test"], ["run"]),
}

function jsRunner(name: string, list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const table = JS_RUNNERS[name] as Verbs
  const first = list.values[0]
  if (first?.startsWith("-")) return first === "--version" || first === "-v" ? SAFE : unknown(`unknown ${name} option ${first} before the command`)
  const index = 0
  const verb = list.values[index]
  if (verb === undefined) return name === "yarn" ? SAFE : unknown(`${name} names no command`)
  if (table.deps.has(verb) || table.read.has(verb) || table.tests.has(verb)) return SAFE
  if (table.run.has(verb)) return script(`${name} run`, list.values.slice(index + 1).find((value) => !value.startsWith("-")))
  if (name === "npm" && verb === "start") return SAFE
  return unknown(`${name} ${verb} is not a command the gate knows`)
}

function cargo(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const verb = list.values.find((value) => !value.startsWith("-"))
  if (verb === undefined) return SAFE
  if (/^(build|b|check|c|test|t|clippy|fmt|doc|bench|add|remove|rm|update|tree|metadata|fetch|run|r|nextest)$/.test(verb)) return SAFE
  return unknown(`cargo ${verb} is not a command the gate knows`)
}

function goTool(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const verb = list.values[0]
  if (verb === undefined) return SAFE
  if (/^(build|test|vet|fmt|mod|list|version|env|doc)$/.test(verb)) return SAFE
  return unknown(`go ${verb} is not a command the gate knows (go run and go generate run code)`)
}

function pip(name: string, list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const verb = list.values[0]
  return verb !== undefined && /^(install|uninstall|list|show|freeze|check)$/.test(verb) ? SAFE : unknown(`${name} ${verb ?? ""} is not a command the gate knows`)
}

/** The test and check tools a Python run may name: `python3 -m pytest`, `uv run ruff`. */
const PY_TOOLS: ReadonlySet<string> = new Set(["pytest", "mypy", "ruff", "pyright", "unittest"])

function uv(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const [verb, ...rest] = list.values
  if (verb === undefined) return SAFE
  if (/^(sync|lock|add|remove|tree|venv|version)$/.test(verb)) return SAFE
  if (verb === "pip") return pip("uv pip", args(list.words.slice(1)))
  if (verb === "run") {
    const tool = rest.find((value) => !value.startsWith("-"))
    if (tool !== undefined && PY_TOOLS.has(tool)) return SAFE
    return unknown(`uv run ${tool ?? ""} runs code the gate cannot read; only ${[...PY_TOOLS].join(", ")} are known forms`)
  }
  return unknown(`uv ${verb} is not a command the gate knows`)
}

function python(name: string, list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const [first, second] = list.values
  if (first === "--version" || first === "-V") return SAFE
  if (first === "-m" && second !== undefined && PY_TOOLS.has(second)) return SAFE
  if (first === "-m" && second === "pip") return pip(`${name} -m pip`, args(list.words.slice(2)))
  return unknown(`${name} runs a program the gate cannot read; only -m ${[...PY_TOOLS].join("|")} is a known form`)
}

function node(list: Args): Need {
  return list.values.length === 1 && (list.values[0] === "--version" || list.values[0] === "-v") ? SAFE : unknown("node runs a program the gate cannot read")
}

function deno(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const verb = list.values[0]
  return verb !== undefined && /^(test|fmt|lint|check|--version)$/.test(verb) ? SAFE : unknown(`deno ${verb ?? ""} runs a program the gate cannot read`)
}

const MAKE_FLAG = /^-(j\d*|k|s|n|B|-keep-going|-silent|-dry-run|-always-make)$/

/** `make <target>` / `just <recipe>`: the repository's own recipes, unless the name looks like a release. */
function recipes(name: string, list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const targets: string[] = []
  for (let index = 0; index < list.values.length; index++) {
    const value = list.values[index] as string
    if (value === "-C" && name === "make") {
      index++
      continue
    }
    if (value.startsWith("-")) {
      if (MAKE_FLAG.test(value) && name === "make") continue
      return unknown(`unknown ${name} option ${value}`)
    }
    if (value.includes("=")) return unknown(`${name} variable ${value} can change what a recipe runs`)
    targets.push(value)
  }
  for (const target of targets) {
    const need = script(name, target)
    if (need.kind !== "safe") return need
  }
  return SAFE
}

/** `npx [-y] cdk ...` only; every other package executor runs code the gate cannot read. */
function packageRunner(runner: string, list: Args): Need {
  let index = 0
  while (index < list.values.length && /^(-y|--yes|--no)$/.test(list.values[index] as string)) index++
  const pkg = list.values[index]
  if (pkg === undefined || list.words[index]?.quoted || list.words[index]?.expands) return unknown(`${runner} names no plain package`)
  const name = pkg === "aws-cdk" || pkg === "cdk" ? "cdk" : undefined
  if (name === undefined) return unknown(`${runner} ${pkg} runs a package the gate cannot read`)
  return deployTool(name, args(list.words.slice(index + 1)))
}

// --- worktrunk ------------------------------------------------------------------------------------

const WT_SWITCH_FLAG: ReadonlySet<string> = new Set(["-c", "--create", "--no-cd", "--no-hooks", "--branches", "--remotes", "--prs", "-y", "--yes"])
const WT_SWITCH_VALUE: ReadonlySet<string> = new Set(["-b", "--base", "--format"])
const WT_REMOVE_FLAG: ReadonlySet<string> = new Set(["--no-delete-branch", "--foreground", "--no-hooks", "-y", "--yes"])
const WT_MERGE_FLAG: ReadonlySet<string> = new Set(["--no-squash", "--no-remove", "--no-commit", "--no-rebase", "--no-hooks", "--no-verify", "-y", "--yes", "--squash"])

function wt(list: Args): Need {
  const problem = unreadable(list)
  if (problem) return problem
  const [verb, ...rest] = list.values
  if (verb === undefined || verb === "list") return SAFE
  if (verb === "switch") {
    const flags = checkFlags(rest, WT_SWITCH_FLAG, WT_SWITCH_VALUE, "wt switch")
    if (flags) return rest.some((value) => value === "-x" || value.startsWith("--execute")) ? unknown("wt switch -x runs a command") : flags
    return rest.includes("--clobber") ? irreversible("wt switch --clobber replaces a directory") : SAFE
  }
  if (verb === "remove") {
    if (rest.some((value) => value === "-D" || value === "--force-delete" || value === "-f" || value === "--force")) return irreversible("wt remove --force deletes unmerged work")
    return checkFlags(rest, WT_REMOVE_FLAG, new Set(), "wt remove") ?? SAFE
  }
  if (verb === "merge") return checkFlags(rest, WT_MERGE_FLAG, new Set(), "wt merge") ?? grant("merge", "wt merge")
  return unknown(`wt ${verb} is not a command the gate knows`)
}

// --- dispatch -------------------------------------------------------------------------------------

/** ANSI-C (`$'…'`) and locale (`$"…"`) quoting: the parser keeps their escapes, so the gate cannot read the word. */
const DOLLAR_QUOTE = /\$['"]/

/** What one simple command needs. `source` is the text the command was scanned from. */
export function classifyCommand(command: SimpleCommand, source: string, context: GateContext = { grants: [], full: false, defaults: NO_DEFAULTS }): Need {
  for (const word of [...command.words, ...command.redirects])
    if (DOLLAR_QUOTE.test(source.slice(word.start, word.end))) return unknown(`\`${source.slice(word.start, word.end)}\` uses $'…' or $"…" quoting`)
  const words = command.words
  let index = 0
  while (index < words.length && !(words[index] as ShellWord).quoted && ASSIGNMENT.test((words[index] as ShellWord).value)) index++
  const head = words[index]
  if (head === undefined) return SAFE
  if (head.quoted || head.expands) return unknown(`command name \`${head.value}\` is quoted or expanded`)
  const name = basename(head.value)
  const rest = args(words.slice(index + 1))
  if (INDIRECT.has(name)) return unknown(`${name} runs code the gate cannot read`)
  switch (name) {
    case "git":
      return git(rest, context)
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
    case "wt":
      return wt(rest)
    case "npx":
      return packageRunner(name, rest)
    case "bunx":
      return unknown("bunx runs a package the gate cannot read")
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return jsRunner(name, rest)
    case "cargo":
      return cargo(rest)
    case "go":
      return goTool(rest)
    case "pip":
    case "pip3":
      return pip(name, rest)
    case "uv":
      return uv(rest)
    case "python":
    case "python3":
      return python(name, rest)
    case "node":
      return node(rest)
    case "deno":
      return deno(rest)
    case "make":
    case "just":
      return recipes(name, rest)
  }
  if (name in DEPLOY_TOOLS) return deployTool(name, rest)
  if (PLAIN_TOOLS.has(name)) return SAFE
  return unknown(`${name} is not a command the gate knows`)
}

/** What a shell source needs, one entry per simple command; one `unknown` when it cannot be read. */
export function classifyShell(source: string, context?: GateContext): Need[] {
  const scan = scanShell(source)
  if (!scan.complete) return [unknown("the command does not parse: a quote, substitution or here-document is left open")]
  if (scan.substitutions.length > 0) return [unknown("the command uses command substitution, which the gate cannot read")]
  const needs = scan.items.flatMap((item) => (item.kind === "command" ? [classifyCommand(item, source, context)] : []))
  return needs.length > 0 ? needs : [unknown("the command is empty")]
}

/** The remotes the `git push` commands in a shell request push to, so the caller can resolve their default branches. */
export function pushRemotes(action: string, resources: readonly string[]): string[] {
  if (!SHELL_ACTIONS.has(action.toLowerCase())) return []
  const remotes = new Set<string>()
  for (const source of resources) {
    const scan = scanShell(source)
    for (const item of scan.items) {
      if (item.kind !== "command") continue
      const values = item.words.map((word) => word.value)
      const at = values.indexOf("push")
      if (at < 1 || basename(values[0] as string) !== "git") continue
      const remote = values.slice(at + 1).find((value) => !value.startsWith("-"))
      if (remote !== undefined) remotes.add(remote)
    }
  }
  return [...remotes]
}

const SHELL_ACTIONS: ReadonlySet<string> = new Set(["shell", "bash"])

/**
 * Permission kinds that act inside the run's location and are safe to approve: reading and
 * editing files there, searching, fetching and searching the web, loading skills, starting
 * subagents, keeping a todo list, and reading MCP resources. Every other kind is denied: shell
 * goes through `classifyShell`, merge tools need the merge grant, and anything else
 * (`external_directory`, `execute`, an MCP or plugin tool such as `safety_secret_command`) is unknown.
 */
const SAFE_ACTIONS: ReadonlySet<string> = new Set([
  "read", "edit", "write", "patch", "glob", "grep", "list", "webfetch", "websearch", "skill", "subagent", "task",
  "todowrite", "todoread", "opencode_list_mcp_resources", "opencode_read_mcp_resource",
])

/** What a permission request needs: shell requests by their commands, merge tools by grant, known kinds by name. */
export function needsOf(action: string, resources: readonly string[], context?: GateContext): Need[] {
  const name = action.toLowerCase()
  if (SHELL_ACTIONS.has(name)) return resources.length > 0 ? resources.flatMap((source) => classifyShell(source, context)) : [unknown("the shell request names no command")]
  if (name === "delivery_land" || name.endsWith("_merge")) return [grant("merge", action)]
  if (SAFE_ACTIONS.has(name)) return [SAFE]
  return [unknown(`permission kind ${action} is not one the gate approves`)]
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
 * be a known safe form, or need only grants the run has. `defaults` are the push remotes'
 * resolved default branches; a push to a remote missing from it is denied.
 */
export function decideAsk(action: string, resources: readonly string[], grants: readonly Grant[], full: boolean, defaults: DefaultBranches = NO_DEFAULTS): AskDecision {
  for (const need of needsOf(action, resources, { grants, full, defaults })) {
    const reason = unmet(need, grants, full)
    if (reason !== undefined) return { effect: "deny", reason }
  }
  return { effect: "allow" }
}
