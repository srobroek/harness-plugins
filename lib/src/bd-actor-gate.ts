import { interpreterCommandString, parse, readsScriptFromStdin, scanShell, stdinSource } from "./beads-shell.ts"

const ACTOR_VARS = ["BEADS_ACTOR", "BD_ACTOR"] as const
type ActorVar = (typeof ACTOR_VARS)[number]

/**
 * Global flags of `bd` itself that consume the next word, read from `bd --help`
 * on 1.3.0. A missing entry is not cosmetic: the parser would take the flag's
 * VALUE for the verb, so `bd --database x close y` would look like verb `x`.
 */
const VALUE_FLAGS = new Set([
  "--actor",
  "--database",
  "--db",
  "-C",
  "--directory",
  "--dolt-auto-commit",
  "--mem-profile",
])

/**
 * Prefixes that keep the following command in command position. They are
 * intentionally limited to shell control words whose condition/body starts
 * with the command immediately after the word; other shell syntax remains
 * fail-closed because it is not a simple invocation.
 */
const CONTROL_PREFIXES: Record<string, true> = {
  "!": true,
  if: true,
  elif: true,
  else: true,
  while: true,
  until: true,
  do: true,
}

const TRANSPARENT_WRAPPERS: Record<string, true> = {
  command: true,
  env: true,
  exec: true,
  nohup: true,
  sudo: true,
  time: true,
}

const WRAPPER_VALUE_FLAGS: Record<string, true> = {
  "-C": true,
  "--chdir": true,
  "--chroot": true,
  "--command-timeout": true,
  "-g": true,
  "--group": true,
  "-h": true,
  "--host": true,
  "-p": true,
  "--prompt": true,
  "-R": true,
  "-T": true,
  "-u": true,
  "--unset": true,
  "--user": true,
}

export interface BdInvocation {
  verb: string
  args: string[]
  /** Global flags and their values, sitting between the `bd` word and the verb. */
  globals: string[]
  /** `NAME=value` assignments prefixed to this very `bd` word. */
  prefix: string[]
  /** Actor values the shell exported before this command, read in order; `null` marks one it cleared or unexported. */
  exported: ActorState
  /** Actor variables removed by an `env -u`/`env -i` wrapper. */
  unset: Partial<Record<ActorVar, true>>
  /**
   * Actor variables whose value here the gate cannot know. Either the command line changes them where the
   * gate cannot place the change, or this `bd` runs nested (a substitution, a pipeline stage, a script fed
   * to a shell) in a command line that changes an actor variable anywhere.
   */
  unverified: Partial<Record<ActorVar, true>>
}

/** A string is an exported value, `null` a variable a shell `unset` cleared or unexported, absent one never touched here. */
type ActorState = Partial<Record<ActorVar, string | null>>

/**
 * One actor variable as the shell holds it. `value` is `undefined` while the ambient environment's value
 * stands and `null` once unset; `exported` is `undefined` while the ambient environment decides. An
 * assignment changes only `value`, an export only `exported`, so the two stay in step.
 */
interface ShellVar {
  value: string | null | undefined
  exported: boolean | undefined
}

/** `"unverified"` marks a variable changed where the gate cannot tell whether, or how, the change ran. */
type ShellVars = Partial<Record<ActorVar, ShellVar | "unverified">>

const OPENERS = new Set(["if", "while", "until", "for", "select", "case"])
const HEADER_ONLY = new Set(["for", "select", "case"])
const CLOSERS = new Set(["fi", "done", "esac"])
const BRANCHES = new Set(["else", "elif"])
const ASSIGNMENT = /^[A-Za-z_]\w*=/
const BOTH: Partial<Record<ActorVar, true>> = { BEADS_ACTOR: true, BD_ACTOR: true }

/** Builtins other than `export` and `unset` that can set or clear a shell variable named in their arguments. */
const VARIABLE_BUILTINS = new Set([
  "declare",
  "eval",
  "getopts",
  "let",
  "local",
  "mapfile",
  "printf",
  "read",
  "readarray",
  "readonly",
  "typeset",
])

const basename = (word: string): string => word.split("/").pop() ?? word

const actorVarOf = (arg: string): ActorVar | undefined =>
  ACTOR_VARS.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`))

/** What a child process inherits, and which actor variables the gate cannot know there. */
function childView(vars: ShellVars): { exported: ActorState; unverified: Partial<Record<ActorVar, true>> } {
  const exported: ActorState = {}
  const unverified: Partial<Record<ActorVar, true>> = {}
  for (const variable of ACTOR_VARS) {
    const entry = vars[variable]
    if (entry === "unverified") unverified[variable] = true
    else if (entry === undefined || entry.exported === undefined) continue
    else if (entry.exported && typeof entry.value === "string") exported[variable] = entry.value
    else if (!entry.exported || entry.value === null) exported[variable] = null
  }
  return { exported, unverified }
}

/** Apply a command-position `export`, `export -n` or `unset` to the shell's actor variables. */
function applyActorBuiltin(vars: ShellVars, values: string[]): void {
  const name = values[0]
  const unexport = name === "export" && values.slice(1).some((arg) => /^-[a-zA-Z]*n/.test(arg))
  for (const arg of values.slice(1)) {
    const variable = actorVarOf(arg)
    if (variable === undefined) continue
    const current = vars[variable]
    if (name === "unset") vars[variable] = { value: null, exported: false }
    else if (arg.includes("=")) vars[variable] = { value: arg.slice(variable.length + 1), exported: !unexport }
    else if (unexport) vars[variable] = { value: current === "unverified" ? undefined : current?.value, exported: false }
    // A name-only export publishes the current value; an unset variable has none to publish.
    else if (current === "unverified") continue
    else if (current !== undefined && current.value !== null) vars[variable] = { value: current.value, exported: true }
  }
}

/** A bare `NAME=value` sets the value and leaves the export flag alone. */
function applyActorAssignments(vars: ShellVars, assignments: string[]): void {
  for (const assignment of assignments) {
    const variable = actorVarOf(assignment)
    const current = variable === undefined ? undefined : vars[variable]
    if (variable !== undefined && current !== "unverified")
      vars[variable] = { value: assignment.slice(variable.length + 1), exported: current?.exported }
  }
}

/** What one top-level command does to the actor variables, on a copy of `vars`. */
function afterCommand(vars: ShellVars, values: string[], assigned: string[]): ShellVars {
  const after = { ...vars }
  const command = values[0] === "builtin" || values[0] === "command" ? values.slice(1) : values
  const name = command[0]
  if (values.length === 0) applyActorAssignments(after, assigned)
  else if (name === "export" || name === "unset") applyActorBuiltin(after, command)
  else if (name !== undefined && VARIABLE_BUILTINS.has(name))
    for (const variable of ACTOR_VARS) {
      if (command.slice(1).some((arg) => arg.includes(variable))) after[variable] = "unverified"
    }
  return after
}

const changedVars = (before: ShellVars, after: ShellVars): ActorVar[] =>
  ACTOR_VARS.filter((variable) => before[variable] !== after[variable])

function markUnverified(vars: ShellVars, variables: ActorVar[]): void {
  for (const variable of variables) vars[variable] = "unverified"
}

/**
 * Whether any command in the parsed tree, other than a `bd` invocation itself, names an actor variable
 * or clears the environment. A `bd` the gate reads nested is judged on the ambient actor only when
 * nothing does; otherwise its actor cannot be verified.
 */
function actorTouched(parsed: { command: string; nested: unknown[] }): boolean {
  for (const item of scanShell(parsed.command, { executableSubstitutionsOnly: true }).items) {
    if (item.kind !== "command") continue
    const values = item.words.map((word) => word.value)
    let first = 0
    while (first < values.length && ASSIGNMENT.test(values[first] ?? "")) first++
    if (resolveBd(values.slice(first), values.slice(0, first)) !== undefined) continue
    if (values.some((value) => ACTOR_VARS.some((variable) => value.includes(variable)))) return true
    if (values.includes("env") && values.some((value) => value === "-" || value === "-i" || value === "--ignore-environment"))
      return true
  }
  return parsed.nested.some((child) => isParsed(child) && actorTouched(child))
}

function isParsed(value: unknown): value is { command: string; nested: unknown[] } {
  if (value === null || typeof value !== "object") return false
  const candidate = value as { command?: unknown; nested?: unknown }
  return typeof candidate.command === "string" && Array.isArray(candidate.nested)
}

/**
 * Every `bd` invocation in the command line, with the environment it runs under.
 *
 * Read from the shared structural scanner, never from the command text: a quoted
 * word is data, so `echo ";" export BEADS_ACTOR=x` exports nothing and `bd comments
 * add x "bd create y"` creates nothing. Executable substitutions and shell-fed
 * here-documents are read too. An `export BEADS_ACTOR=x` counts for the commands after it;
 * a bare `BEADS_ACTOR=x; bd close y` never does, since without `export` it does not reach `bd`.
 */
export function bdInvocations(command: string): BdInvocation[] {
  return readShell(command, { nested: false, touched: actorTouched(parse(command)) })
}

/** An `&&` / `||` chain after its first command: the variables then, and whether a `||` has come. */
interface Chain {
  base: ShellVars
  or: boolean
}

/**
 * Read `command`. At the top level the actor variables are followed through `;`, newline, `&&`, `||`,
 * `&`, subshells and brace groups. Full shell emulation is out of scope: a change the gate cannot place
 * (a chain member that may not run, a compound body, the final pipeline stage, `eval`) leaves the
 * variable unverified, and a nested `bd` (a substitution, a pipeline stage, a script fed to a shell)
 * gets no state at all, only `touched`.
 */
function readShell(command: string, context: { nested: boolean; touched: boolean }): BdInvocation[] {
  const out: BdInvocation[] = []
  const scan = scanShell(command, { executableSubstitutionsOnly: true })
  const child = { nested: true, touched: context.touched }
  let vars: ShellVars = {}
  // The variables as the current list began; a list run in the background changes nothing after it.
  let list: ShellVars = {}
  // Set after the first command of an `&&` / `||` chain: the variables then, and whether a `||` has come.
  let chain: Chain | null = null
  // A subshell `( … )` runs on a copy; whatever it does ends with it.
  const scopes: Array<{ vars: ShellVars; list: ShellVars; chain: Chain | null }> = []
  // Compound-command depth: a body may not run, so what it changes is unverified.
  let compounds = 0
  const isPipe = (other: (typeof scan.items)[number] | undefined): boolean =>
    other?.kind === "operator" && (other.operator === "|" || other.operator === "|&")
  // A chain member after the first may not have run, so what it changed is unverified once the chain ends.
  const endChain = (): void => {
    if (chain !== null) markUnverified(vars, changedVars(chain.base, vars))
    chain = null
  }

  for (const [index, item] of scan.items.entries()) {
    if (item.kind === "operator") {
      const operator = item.operator
      if (operator === "(") {
        scopes.push({ vars, list, chain })
        vars = { ...vars }
        list = { ...vars }
        chain = null
      } else if (operator === ")" && scopes.length > 0) ({ vars, list, chain } = scopes.pop() as (typeof scopes)[number])
      else if (operator === "&&" || operator === "||") {
        chain ??= { base: { ...vars }, or: false }
        // What runs after `||` may follow a failure of the commands before it.
        if (operator === "||") {
          markUnverified(vars, changedVars(chain.base, vars))
          chain.or = true
        }
      } else if (operator === ";" || operator === "\n") {
        endChain()
        list = { ...vars }
      } else if (operator === "&") {
        endChain()
        vars = list
        list = { ...vars }
      }
      continue
    }

    const words = item.words
    let k = 0
    let skip = false
    while (k < words.length && words[k]?.quoted === false) {
      const value = words[k]?.value as string
      if (OPENERS.has(value)) {
        compounds++
        skip = HEADER_ONLY.has(value)
      } else if (CLOSERS.has(value)) {
        compounds = Math.max(0, compounds - 1)
        skip = true
      } else if (!BRANCHES.has(value) && value !== "!" && value !== "then" && value !== "do") break
      k++
      if (skip) break
    }
    if (skip) continue

    let a = k
    while (a < words.length && ASSIGNMENT.test(command.slice(words[a]?.start, words[a]?.end))) a++
    const assigned = words.slice(k, a).map((word) => word.value)
    const values = words.slice(a).map((word) => word.value)
    const inPipeline = isPipe(scan.items[index - 1]) || isPipe(scan.items[index + 1])
    const found = resolveBd(values, assigned)

    if (!context.nested && found === undefined) {
      const after = afterCommand(vars, values, assigned)
      const changed = changedVars(vars, after)
      // Every pipeline stage but the last runs in a subshell in every shell; the last one does in bash
      // but not in zsh or under `lastpipe`.
      const finalStage = isPipe(scan.items[index - 1]) && !isPipe(scan.items[index + 1])
      if (changed.length > 0 && !(inPipeline && !finalStage)) {
        if (finalStage || compounds > 0 || chain?.or === true) markUnverified(vars, changed)
        else vars = after
      }
    }

    if (found !== undefined) {
      const scanned = scanGlobals(values, found.next)
      const verb = values[scanned.next]
      if (verb !== undefined) {
        const placed = !context.nested && !inPipeline
        const view = placed ? childView(vars) : { exported: {}, unverified: context.touched ? BOTH : {} }
        out.push({
          verb: verb.toLowerCase(),
          args: values.slice(scanned.next + 1),
          globals: scanned.globals,
          prefix: found.prefix,
          exported: view.exported,
          unset: found.unset,
          unverified: { ...view.unverified },
        })
      }
    }
    const inline = interpreterCommandString(values)
    if (inline !== undefined) out.push(...readShell(inline, child))
    if (readsScriptFromStdin(values)) {
      const script = stdinSource(item)
      if (script !== undefined) out.push(...readShell(script, child))
    }
  }
  for (const source of scan.substitutions) out.push(...readShell(source, child))
  return out
}

/** The `bd` word after shell assignments and transparent wrappers, with what those wrappers set. */
function resolveBd(
  values: string[],
  assigned: string[],
): { next: number; prefix: string[]; unset: Partial<Record<ActorVar, true>> } | undefined {
  let i = 0
  const prefix = [...assigned]
  const unset: Partial<Record<ActorVar, true>> = {}
  while (true) {
    const word = basename(values[i] ?? "")
    if (CONTROL_PREFIXES[word] === true) {
      i++
      continue
    }
    if (TRANSPARENT_WRAPPERS[word] !== true) break
    i++
    if (word === "command") {
      // `command -v bd` only describes `bd`; `command -- bd` and `command -p bd` run it.
      let describes = false
      while (values[i]?.startsWith("-") === true) {
        const flag = values[i] as string
        i++
        if (flag === "--") break
        if (/^-[A-Za-z]*[vV]/.test(flag)) describes = true
      }
      if (describes) return undefined
      continue
    }
    while (true) {
      while (ASSIGNMENT.test(values[i] ?? "")) {
        const assignment = values[i] as string
        prefix.push(assignment)
        const variable = assignment.slice(0, assignment.indexOf("="))
        if (variable === "BEADS_ACTOR" || variable === "BD_ACTOR") delete unset[variable]
        i++
      }
      const flag = values[i]
      if (flag === undefined || !flag.startsWith("-")) break
      if (word === "env") {
        if (flag === "--") {
          i++
          break
        }
        if (flag === "-i" || flag === "--ignore-environment") {
          unset.BEADS_ACTOR = true
          unset.BD_ACTOR = true
          i++
          continue
        }
        const unsetName =
          flag === "-u" || flag === "--unset"
            ? values[i + 1]
            : flag.startsWith("--unset=")
              ? flag.slice("--unset=".length)
              : flag.startsWith("-u") && flag.length > 2
                ? flag.slice(2)
                : undefined
        if (unsetName === "BEADS_ACTOR" || unsetName === "BD_ACTOR") unset[unsetName] = true
        if (flag === "-u" || flag === "--unset") i += 2
        else i++
        continue
      }
      i++
      if (WRAPPER_VALUE_FLAGS[flag] === true) i++
    }
  }
  const word = values[i]
  if (word === undefined || basename(word) !== "bd") return undefined
  return { next: i + 1, prefix, unset }
}

/**
 * The global flags between `bd` and its verb, and where the verb starts.
 *
 * `--flag=value` is one word and consumes nothing after it. Reading it as a bare
 * flag would take the NEXT word for the value and leave the verb one place off,
 * which is how `--directory=/path` came to resolve the wrong store.
 */
function scanGlobals(tokens: string[], from: number): { globals: string[]; next: number } {
  const globals: string[] = []
  let i = from
  while (true) {
    const flag = tokens[i]
    if (flag === undefined || !flag.startsWith("-")) break
    globals.push(flag)
    i++
    if (flag.includes("=")) continue
    if (!VALUE_FLAGS.has(flag)) continue
    const value = tokens[i]
    if (value !== undefined) globals.push(value)
    i++
  }
  return { globals, next: i }
}

/** The value a global flag carries, in either the `--flag value` or `--flag=value` spelling. */
export function globalValue(globals: string[], names: string[]): string | undefined {
  for (const [index, token] of globals.entries()) {
    for (const name of names) {
      if (token === name) return globals[index + 1]
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1)
    }
  }
  return undefined
}

/**
 * Whether a boolean flag is switched ON, in any spelling the CLI accepts.
 *
 * `--flag` and `--flag=true` are on; `--flag=false` is OFF and treating it as
 * present inverted the meaning of `--readonly=false` and `--help=false`. A value
 * bd itself would reject counts as off, because such a command fails and writes
 * nothing.
 */
export function flagEnabled(tokens: string[], names: string[]): boolean {
  for (const token of tokens) {
    for (const name of names) {
      if (token === name) return true
      if (token.startsWith(`${name}=`)) return TRUTHY[token.slice(name.length + 1)] === true
      // `bd orphans -fj` is `-f -j`, so a fused run of short booleans has to be
      // read letter by letter; matching the whole token missed `-f` entirely.
      if (name.length === 2 && name.startsWith("-") && /^-[A-Za-z]{2,}$/.test(token) && token.includes(name.slice(1))) {
        return true
      }
    }
  }
  return false
}

/** The values Go's flag parsing reads as true. */
const TRUTHY: Record<string, true> = { "": true, "1": true, t: true, T: true, TRUE: true, true: true, True: true }

/** Hunt trigger verbs for `bd_mutate_actor_claim`. */
export const MUTATING_VERBS: Record<string, true> = {
  assign: true,
  batch: true,
  claim: true,
  close: true,
  done: true,
  comment: true,
  cook: true,
  create: true,
  "create-form": true,
  defer: true,
  delete: true,
  duplicate: true,
  edit: true,
  forget: true,
  import: true,
  link: true,
  new: true,
  note: true,
  priority: true,
  promote: true,
  q: true,
  remember: true,
  rename: true,
  reopen: true,
  "set-state": true,
  ship: true,
  supersede: true,
  tag: true,
  undefer: true,
  update: true,
}

const GROUP_WRITES: Record<string, Record<string, true>> = {
  audit: { label: true, record: true },
  comments: { add: true },
  dep: { add: true, relate: true, remove: true, unrelate: true },
  epic: { "close-eligible": true },
  gate: { "add-waiter": true, check: true, create: true, resolve: true },
  kv: { append: true, delete: true, rm: true, set: true, update: true },
  label: { add: true, propagate: true, remove: true },
  "merge-slot": { acquire: true, create: true, release: true },
  swarm: { create: true },
  todo: { add: true, done: true },
}

const MOL_WRITES: Record<string, true> = {
  bond: true,
  burn: true,
  distill: true,
  pour: true,
  squash: true,
}

export { commandFromInput as extractCommand } from "./beads-shell.ts"

/** The environment a bash tool call supplies to its child process. */
export function environmentForInput(
  input: unknown,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const supplied =
    input !== null && typeof input === "object" ? (input as { env?: unknown }).env : undefined
  if (supplied !== null && typeof supplied === "object") {
    for (const [name, value] of Object.entries(supplied)) {
      if (typeof value === "string") env[name] = value
    }
  }
  return env
}

export { agentActor } from "./beads-host.ts"

const literal = (value: string | undefined): string | null => {
  if (!value?.trim() || /[$`\\\0]/.test(value)) return null
  return value.trim()
}

/** The actor one variable gives this invocation: `null` for none, `undefined` when the gate cannot know it. */
function variableActor(invocation: BdInvocation, variable: ActorVar, env: NodeJS.ProcessEnv): string | null | undefined {
  if (invocation.unset[variable] === true) return null
  const assignment = invocation.prefix.findLast((token) => token.startsWith(`${variable}=`))
  if (assignment !== undefined) return literal(assignment.slice(variable.length + 1))
  if (invocation.unverified[variable] === true) return undefined
  // A cleared variable stays cleared: the ambient value must not come back.
  const exported = invocation.exported[variable]
  if (exported === null) return null
  return literal(exported ?? env[variable])
}

/**
 * The ONE actor this invocation will really write under, or `null` when it has none or the gate
 * cannot name it.
 *
 * Measured against bd 1.3.0: an explicit `--actor` flag wins, followed by
 * BEADS_ACTOR (command-local assignment, exported assignment, then ambient
 * environment), and finally BD_ACTOR with the same source precedence.
 */
export function invocationActor(invocation: BdInvocation, env: NodeJS.ProcessEnv): string | null {
  const explicit = literal(globalValue(invocation.globals, ["--actor"]))
  if (explicit !== null) return explicit
  const canonical = variableActor(invocation, "BEADS_ACTOR", env)
  if (canonical === undefined) return null
  return canonical ?? variableActor(invocation, "BD_ACTOR", env) ?? null
}

/**
 * Whether the invocation writes under some actor. `unverified` when that depends on a variable
 * the gate cannot know; a literal from either variable still settles it, since bd then has an actor.
 */
function actorStatus(invocation: BdInvocation, env: NodeJS.ProcessEnv): "present" | "missing" | "unverified" {
  if (literal(globalValue(invocation.globals, ["--actor"])) !== null) return "present"
  const canonical = variableActor(invocation, "BEADS_ACTOR", env)
  const legacy = variableActor(invocation, "BD_ACTOR", env)
  if (typeof canonical === "string" || typeof legacy === "string") return "present"
  return canonical === undefined || legacy === undefined ? "unverified" : "missing"
}

/**
 * Every actor a command line writes under: one per mutating invocation, deduped.
 *
 * Still plural, because one command line can carry several invocations under
 * different actors. What it no longer does is report two actors for a single write
 * because two variables were set.
 */
export function actorValues(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const actors = bdInvocations(command)
    .filter(isMutatingInvocation)
    .map((invocation) => invocationActor(invocation, env))
    .filter((actor): actor is string => actor !== null)
  return [...new Set(actors)]
}

export function actorPresent(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const first = bdInvocations(command)[0]
  return first !== undefined && invocationActor(first, env) !== null
}

/**
 * One `bd` invocation read from an argv the plugin itself builds, so an internal
 * spawn is classified by the same rules as a command line an agent typed.
 * `undefined` when the argv carries no verb.
 */
export function invocationFromArgv(args: string[]): BdInvocation | undefined {
  const scanned = scanGlobals(args, 0)
  const verb = args[scanned.next]
  if (verb === undefined) return undefined
  return {
    verb: verb.toLowerCase(),
    args: args.slice(scanned.next + 1),
    globals: scanned.globals,
    prefix: [],
    exported: {},
    unset: {},
    unverified: {},
  }
}

/** First literal `bd` invocation, after global flags. */
export function firstBdVerb(command: string): string | null {
  return bdInvocations(command)[0]?.verb ?? null
}

export function isMutatingInvocation({ verb, args }: BdInvocation): boolean {
  if (args.includes("--help") || args.includes("-h")) return false
  if (verb === "duplicates") return args.includes("--auto-merge") && !args.includes("--dry-run")
  if (MUTATING_VERBS[verb] === true) return true
  if (verb === "ready") return flagEnabled(args, ["--claim"])
  if (verb === "dep" && args.includes("--blocks")) return true
  if (verb === "mol") {
    if (args.includes("--dry-run")) return false
    const action = args[0] ?? ""
    if (MOL_WRITES[action] === true) return true
    if (action !== "wisp") return false
    const wispAction = args[1]
    return wispAction === "create" || wispAction === "gc" || (wispAction !== undefined && wispAction !== "list")
  }
  const action = args[0] ?? ""
  return GROUP_WRITES[verb]?.[action] === true
}

export function isMutatingBdCommand(command: string): boolean {
  return bdInvocations(command).some(isMutatingInvocation)
}

/** `bd update <id> --claim` or `bd claim <id>`, at shell command position. */
export function isClaimCommand(command: string): boolean {
  return bdInvocations(command).some(
    ({ verb, args }) => verb === "claim" || ((verb === "update" || verb === "ready") && flagEnabled(args, ["--claim"])),
  )
}

export type ActorGateDecision =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "advisory"; text: string }

const CLAIM_REASON =
  "bd claim / `bd update <id> --claim` without BEADS_ACTOR or BD_ACTOR creates undistinguishable dead claims. The plugin starts every subagent shell call with BD_ACTOR, so this command removed or blanked it; drop the `unset` or the empty assignment and run the bare `bd` command."

/**
 * Verbs that construct a new issue. Without an actor, `created_by` records the
 * invoking human's git identity; Owner is always the git identity and never
 * identifies the agent. All three verbs must refuse rather than warn so the
 * new issue is attributable before it is created.
 */
const CREATING_VERBS: Record<string, true> = {
  create: true,
  "create-form": true,
  new: true,
}

const CREATE_REASON =
  "bd create / `bd new` / `bd create-form` without BEADS_ACTOR or BD_ACTOR records the invoking human's git identity in created_by. Owner is always the git identity and never identifies the agent. The plugin starts every subagent shell call with BD_ACTOR, so this command removed or blanked it; drop the `unset` or the empty assignment and run the bare `bd` command."

const ADVISORY_TEXT =
  "BEADS_ACTOR and BD_ACTOR are unset on this mutating `bd` command. Without an actor, created_by records the invoking human's git identity; Owner is always the git identity and never identifies the agent. The plugin starts every subagent shell call with BD_ACTOR, so this command removed or blanked it; drop the `unset` or the empty assignment and run the bare `bd` command."

const UNVERIFIED_TEXT =
  "This command changes BEADS_ACTOR or BD_ACTOR where the actor gate cannot follow the change, or runs a mutating `bd` where the gate cannot place it (a command substitution, a pipeline stage, `eval`, a script run by `bash -c` or fed to a shell). The gate does not emulate the shell, so it cannot verify the actor of that `bd`. Run the `bd` command at the top level of the command line, or drop the change to the actor variables."

/** The gate's verdict over a set of invocations. Duplicates do not change it. */
function decideInvocations(invocations: BdInvocation[], env: NodeJS.ProcessEnv): ActorGateDecision {
  let missing = false
  let unverified = false
  for (const invocation of invocations) {
    if (!isMutatingInvocation(invocation)) continue
    const status = actorStatus(invocation, env)
    if (status === "present") continue
    // Never refuse on a state the gate could not follow: an unverified actor only warns.
    if (status === "unverified") {
      unverified = true
      continue
    }
    const { verb, args } = invocation
    const claim = verb === "claim" || ((verb === "update" || verb === "ready") && flagEnabled(args, ["--claim"]))
    if (claim) return { kind: "block", reason: CLAIM_REASON }
    if (CREATING_VERBS[verb] === true) return { kind: "block", reason: CREATE_REASON }
    missing = true
  }
  const texts = [...(missing ? [ADVISORY_TEXT] : []), ...(unverified ? [UNVERIFIED_TEXT] : [])]
  return texts.length > 0 ? { kind: "advisory", text: texts.join(" ") } : { kind: "allow" }
}

/**
 * Decide on the parsed command and every child the parser found in it. The children (substitutions,
 * scripts fed to a shell, `bash -c`, `eval` and `xargs` bodies) are read nested: their own `--actor`,
 * prefix and wrapper unsets count, and otherwise the ambient actor counts only when nothing on the
 * command line changes an actor variable.
 */
export function decideActorParsed(
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ActorGateDecision {
  if (!isParsed(parsed)) return { kind: "block", reason: "command could not be parsed" }
  // Decide on the original command text. Re-joining argv with spaces drops quoting, so a
  // quoted "; bd create" would become a command and prefix assignments would vanish.
  const touched = actorTouched(parsed)
  const invocations = readShell(parsed.command, { nested: false, touched })
  const pending = [...parsed.nested]
  while (pending.length > 0) {
    const child = pending.shift()
    if (!isParsed(child)) return { kind: "block", reason: "command could not be parsed" }
    invocations.push(...readShell(child.command, { nested: true, touched }))
    pending.push(...child.nested)
  }
  return decideInvocations(invocations, env)
}

/**
 * Scope: this gate is an attribution aid. The plugin injects an actor into every session's
 * `bd` calls, so its verdict is advisory (see shell-gates), and it cannot stop an agent that
 * sets a wrong actor on purpose. The other gates that read commands through the shared parser
 * (close, update-close, unclaim, the embedded-write lock, the wait guard) are real controls;
 * parser bugs that let a command slip past them are bugs to fix.
 */
export function decideActorGate(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ActorGateDecision {
  return decideInvocations(bdInvocations(command), env)
}
