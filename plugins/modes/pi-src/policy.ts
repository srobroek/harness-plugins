/**
 * What each mode may do on pi, decided from a tool call alone. The pi adapter (`modes.ts`) only reads
 * the session and applies the verdict.
 *
 * Each mode has a tool allowlist and the permission rules of its OpenCode agent (`agents.src/<id>.md`),
 * evaluated the way OpenCode does: the last matching rule wins, nothing matching means `ask`. The rules
 * keep OpenCode's order and patterns; only the host parts differ (pi's scratch roots, `scout` for
 * OpenCode's `explore`, no `seance` helper), and `policy.test.ts` checks the two stay in step. On top
 * of the rules, `debug` and `refactor` get the OpenCode plugin's git allowlist and `debug` its
 * segment-aware write guard.
 *
 * Every refusal is fail-closed: a tool outside the allowlist, a call whose target cannot be read, or a
 * shape the guard does not know is denied rather than allowed.
 */

import { isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { leadingCd, type ParsedCommand, parse } from "@srobroek/opencode-lib/shell-command"
import { writeTargets } from "@srobroek/opencode-lib/tool-targets"
import { inspectShellCall } from "../opencode/src/git-guard.ts"
import { AGENT_IDS, type AgentId, MODE_ROLES } from "../opencode/src/modes.ts"
import { canonical, checkDebugWrite, readings, type ScratchRoots } from "../opencode/src/path-guard.ts"

export { AGENT_IDS, type AgentId }

/** pi's debug roots: the ledger in `~/.pi/debug/`, worktrees as `~/.local/share/pi/worktree/<project>/debug-<slug>`. */
export const PI_SCRATCH: ScratchRoots = { ledger: ".pi/debug", worktrees: ".local/share/pi/worktree" }

/** The tool this extension registers; mode agents list it, so a child without the guard fails before its first turn. */
export const STATUS_TOOL = "modes_status"

/** Tools pi-subagents adds to a child session for its own contracts; none of them touches files. */
export const RUNTIME_TOOLS: ReadonlySet<string> = new Set(["structured_output", "contact_supervisor", "intercom", "bg_wait"])

const READ_TOOLS = ["read", "grep", "find", "ls"]
/** pi-lens's read-only tools. Its rename and replace tools write files past the path checks, so no mode gets them. */
const LENS_READ_TOOLS = [
  "symbol_search",
  "module_report",
  "project_report",
  "read_symbol",
  "read_enclosing",
  "ast_grep_search",
  "ast_grep_outline",
  "lens_diagnostics",
  "pi_lens_activate_tools",
]
const WEB_TOOLS = ["web_search", "fetch_content", "get_search_content", "source_check"]
/**
 * context-mode's tools that index, search and report. None takes a command: `ctx_doctor` takes no input,
 * and `ctx_index` stores a file, a string or a URL in context-mode's database (`indexVerdict` allows the
 * string and, under the mode's web rule, the URL).
 */
export const CONTEXT_TOOLS: readonly string[] = ["ctx_index", "ctx_search", "ctx_resume", "ctx_stats", "ctx_doctor"]
/** context-mode's tools that run code the guard cannot check: `ctx_execute` runs a script in any language, `ctx_batch` shell commands. */
export const CODE_RUNNING_TOOLS: ReadonlySet<string> = new Set(["ctx_execute", "ctx_batch"])
/** context-mode's administrative tools, left off every mode's list: they update the install and delete indexed data. */
export const CONTEXT_ADMIN_TOOLS: ReadonlySet<string> = new Set(["ctx_upgrade", "ctx_purge"])
const MODE_TOOL_LIST = [
  ...READ_TOOLS,
  "bash",
  "edit",
  "write",
  "subagent",
  "contact_supervisor",
  STATUS_TOOL,
  ...LENS_READ_TOOLS,
  ...WEB_TOOLS,
  ...CONTEXT_TOOLS,
]

/** The tools each mode may call. Each `common/agents/<id>.pi.md` lists exactly these. */
export const MODE_TOOLS: Readonly<Record<AgentId, readonly string[]>> = {
  debug: MODE_TOOL_LIST,
  refactor: MODE_TOOL_LIST,
  concept: MODE_TOOL_LIST,
}

type Effect = AgentPermission["effect"]
const rule = (action: string, resource: string, effect: Effect): AgentPermission => ({ action, resource, effect })

const ENV_READS = [
  rule("read", "*", "allow"),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("read", "*.env.example", "allow"),
]

const DEBUG_LEDGER = `~/${PI_SCRATCH.ledger}/*`
const DEBUG_WORKTREES = `~/${PI_SCRATCH.worktrees}/*/debug-*/*`
const CONCEPT_SCRATCH = "~/.pi/concept/*"

const FROZEN_TESTS = [
  "*.test.*",
  "*.spec.*",
  "*_test.*",
  "*/test_*.py",
  "test_*.py",
  "tests/*",
  "*/tests/*",
  "test/*",
  "*/test/*",
  "__tests__/*",
  "*/__tests__/*",
  "*__snapshots__/*",
  "*.snap",
  "testdata/*",
  "*/testdata/*",
  "fixtures/*",
  "*/fixtures/*",
]

const PUSH_AND_CLEAN = ["git push*", "git clean*", "rm -rf*", "git -C * push*", "git -c * push*", "git -C * clean*", "git -c * clean*"]

const helpers = (names: readonly string[]) => [rule("subagent", "*", "deny"), ...names.map((name) => rule("subagent", name, "allow"))]
const WEB_FETCH = rule("webfetch", "*", "allow")

/**
 * The read, external_directory, edit, shell, webfetch and subagent rules of each OpenCode agent, in its
 * order, with pi's paths. OpenCode applies `external_directory` to reads as well; pi does not ask before
 * a read outside the project, so only writes outside it check those rules.
 */
export const MODE_RULES: Readonly<Record<AgentId, readonly AgentPermission[]>> = {
  debug: [
    rule("*", "*", "deny"),
    ...ENV_READS,
    rule("external_directory", "*", "ask"),
    rule("external_directory", DEBUG_LEDGER, "allow"),
    rule("read", DEBUG_LEDGER, "allow"),
    rule("external_directory", DEBUG_WORKTREES, "allow"),
    rule("read", DEBUG_WORKTREES, "allow"),
    rule("edit", "*", "deny"),
    rule("edit", DEBUG_LEDGER, "allow"),
    rule("edit", DEBUG_WORKTREES, "allow"),
    rule("shell", "*", "allow"),
    ...PUSH_AND_CLEAN.map((pattern) => rule("shell", pattern, "deny")),
    WEB_FETCH,
    ...helpers(["scout", "researcher", "adversarial-challenger", "architect"]),
  ],
  refactor: [
    rule("*", "*", "deny"),
    ...ENV_READS,
    rule("external_directory", "*", "ask"),
    rule("edit", "*", "allow"),
    ...FROZEN_TESTS.map((pattern) => rule("edit", pattern, "deny")),
    rule("shell", "*", "allow"),
    ...["git push*", "git reset --hard*", "git rebase*", "git clean*", "rm -rf*"].map((pattern) => rule("shell", pattern, "deny")),
    ...["push*", "clean*", "rebase*", "reset --hard*"].flatMap((sub) => [
      rule("shell", `git -C * ${sub}`, "deny"),
      rule("shell", `git -c * ${sub}`, "deny"),
    ]),
    WEB_FETCH,
    ...helpers(["scout", "mechanic", "refactor-challenger", "bloodhound", "code-reviewer", "architect", "debug"]),
  ],
  concept: [
    rule("*", "*", "deny"),
    ...ENV_READS,
    rule("external_directory", "*", "ask"),
    rule("external_directory", CONCEPT_SCRATCH, "allow"),
    rule("read", CONCEPT_SCRATCH, "allow"),
    rule("edit", CONCEPT_SCRATCH, "allow"),
    rule("edit", "docs/design/*", "allow"),
    rule("edit", "docs/adr/*", "allow"),
    rule("edit", "docs/decisions/*", "allow"),
    rule("shell", "*", "ask"),
    ...["git status*", "git log*", "git diff*", "git show*", "python3 -m http.server*"].map((pattern) => rule("shell", pattern, "allow")),
    WEB_FETCH,
    ...helpers(["scout", "researcher", "architect", "adversarial-challenger", "design-critic", "ui-ux-specialist", "a11y-auditor"]),
  ],
}

/** A decision on one tool call. `headCheck` names the directory whose checked-out branch must be read before a mutating git command runs. */
export type Verdict = { effect: "allow"; headCheck?: string } | { effect: "ask" | "deny"; reason: string }

/** Where the call runs: the session directory (the user's checkout) and the home directory. */
export type CallEnv = { cwd: string; home: string }

const RANK: Readonly<Record<Effect, number>> = { allow: 0, ask: 1, deny: 2 }
const ALLOW: Verdict = { effect: "allow" }

/** The strictest of `verdicts`; the first one of that strictness keeps its reason. */
function strictest(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce((worst, next) => (RANK[next.effect] > RANK[worst.effect] ? next : worst), ALLOW)
}

/** `effect` as a verdict; `what` completes "<Mode> mode may not …" or "<Mode> mode needs the user's approval to …". */
function verdict(mode: AgentId, effect: Effect, what: string): Verdict {
  if (effect === "allow") return ALLOW
  const name = MODE_ROLES[mode].name
  return { effect, reason: effect === "deny" ? `${name} mode may not ${what}` : `${name} mode needs the user's approval to ${what}` }
}

/**
 * The path pi's file tools open for `raw`, before `..` is applied: they strip one leading `@`, expand
 * `~`, `~/` and `file://` URLs, and resolve anything relative from the session directory.
 */
export function toolPath(raw: string, env: CallEnv): string {
  let path = raw.startsWith("@") ? raw.slice(1) : raw
  if (path === "~") path = env.home
  else if (path.startsWith("~/")) path = join(env.home, path.slice(2))
  else if (path.startsWith("file://")) path = fileURLToPath(path)
  return isAbsolute(path) ? path : `${env.cwd}${sep}${path}`
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** `rules` with each `~/` pattern spelled from `home`, for matching absolute paths outside the project. */
function homeRules(rules: readonly AgentPermission[], home: string): AgentPermission[] {
  return rules.map((r) => (r.resource.startsWith("~/") ? { ...r, resource: join(home, r.resource.slice(2)) } : r))
}

/** The verdict of `action` rules on one resolved path: project-relative inside the checkout, absolute outside it. */
function pathVerdict(mode: AgentId, action: "read" | "edit", path: string, start: string, home: string, raw: string): Verdict {
  const rules = MODE_RULES[mode]
  if (inside(path, start)) {
    const rel = relative(start, path).split(sep).join("/")
    return verdict(mode, permissionEffect(rules, action, rel), `${action} ${raw}`)
  }
  const outside = homeRules(rules, home)
  const effects: Effect[] = [permissionEffect(outside, action, path)]
  if (action === "edit") effects.push(permissionEffect(outside, "external_directory", path))
  const effect = effects.reduce((worst, next) => (RANK[next] > RANK[worst] ? next : worst), "allow")
  return verdict(mode, effect, `${action} ${raw}, outside the project`)
}

/** The verdict on reading or writing `raw` under both readings of the path (symlinks followed, and `..` by name). */
function fileVerdict(mode: AgentId, action: "read" | "edit", raw: string, env: CallEnv): Verdict {
  try {
    const start = canonical(env.cwd)
    const home = canonical(env.home)
    return strictest(readings(toolPath(raw, env)).map((path) => pathVerdict(mode, action, path, start, home, raw)))
  } catch (error) {
    return { effect: "deny", reason: `${raw} could not be resolved (${(error as Error).message}), so the call is refused` }
  }
}

function writeVerdict(mode: AgentId, toolName: string, input: unknown, env: CallEnv): Verdict {
  const targets = writeTargets(toolName, input)
  if (targets.length === 0) return { effect: "deny", reason: "the write has no readable target path, so it cannot be checked" }
  return strictest(
    targets.flatMap((raw) => {
      const rules = fileVerdict(mode, "edit", raw, env)
      if (mode !== "debug") return [rules]
      const scratch = checkDebugWrite(toolPath(raw, env), { home: env.home, startDir: env.cwd, roots: PI_SCRATCH })
      return [rules, ...(scratch === undefined ? [] : [{ effect: "deny", reason: scratch } as const])]
    }),
  )
}

/** Each simple command's text, nested substitutions included. */
function commandTexts(parsed: ParsedCommand): string[] {
  return [...parsed.commands.map((command) => command.raw), ...parsed.nested.flatMap(commandTexts)]
}

/**
 * pi's bash has no `workdir` field, which the git guard trusts for commands that write. A leading
 * `cd <dir> &&` that `leadingCd` reads as a literal directory stands in for it when everything after
 * it is chained with `&&` or pipes, so nothing runs when `cd` fails; `||`, `;`, `&` or a newline
 * (even quoted) keeps the command as written. The cut is the length of `leadingCd`'s own match, so the
 * directory and the stripped text come from one parse. Any other leading `cd` also stays in the
 * command, where the git guard sees it and refuses git that writes.
 */
export function shellWorkdir(command: string, cwd: string): { command: string; workdir?: string } {
  const lead = leadingCd(command, cwd)
  if (lead.kind !== "dir") return { command }
  const rest = command.slice(lead.length)
  if (rest.trim() === "" || /\|\||;|\n|(?<!&)&(?!&)/.test(rest)) return { command }
  return { command: rest, workdir: lead.dir }
}

/** The shell rules on the whole command and on each simple command in it, as OpenCode checks a compound command. */
function shellVerdict(mode: AgentId, input: unknown, env: CallEnv): Verdict {
  const command = (input as { command?: unknown } | null)?.command
  if (typeof command !== "string" || command.trim() === "") {
    return { effect: "deny", reason: "the bash call has no readable command, so it cannot be checked" }
  }
  const texts = [command.trim(), ...commandTexts(parse(command))]
  const rules = strictest(texts.map((text) => verdict(mode, permissionEffect(MODE_RULES[mode], "shell", text), `run \`${text}\``)))
  if (rules.effect === "deny" || mode === "concept") return rules
  const git = inspectShellCall("bash", shellWorkdir(command, env.cwd), mode, { startDir: env.cwd, home: env.home, roots: PI_SCRATCH })
  if (git.reason !== undefined) {
    const hint = /shell workdir/.test(git.reason) ? "; on pi, start the call with `cd <worktree> && ` and chain the rest with `&&`" : ""
    return { effect: "deny", reason: `${git.reason}${hint}` }
  }
  if (rules.effect === "ask") return rules
  return git.mutates ? { effect: "allow", headCheck: git.workdir ?? env.cwd } : ALLOW
}

/** `subagent` actions that only read or stop runs; every other action is refused. */
const SUBAGENT_READ_ACTIONS: ReadonlySet<string> = new Set(["status", "list", "get", "guide", "models", "doctor", "stop"])

/** Only a single launch of a named helper, or a read-only action, can be checked against the mode's helper list. */
function subagentVerdict(mode: AgentId, input: unknown): Verdict {
  const call = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const name = MODE_ROLES[mode].name
  if (call.workflow !== undefined) {
    return { effect: "deny", reason: `${name} mode launches one named helper at a time; a workflow can start agents it cannot check` }
  }
  if (call.action !== undefined) {
    return typeof call.action === "string" && SUBAGENT_READ_ACTIONS.has(call.action)
      ? ALLOW
      : { effect: "deny", reason: `${name} mode allows only the ${[...SUBAGENT_READ_ACTIONS].join(", ")} subagent actions` }
  }
  if (typeof call.agent !== "string") return { effect: "deny", reason: `${name} mode needs the helper named in \`agent\`` }
  return verdict(mode, permissionEffect(MODE_RULES[mode], "subagent", call.agent), `launch ${call.agent}`)
}

/**
 * `ctx_index` stores what it reads in context-mode's database, and `ctx_search` returns it. Text the
 * caller passes as `content` is already in the conversation. A `url` is a web fetch, so it follows the
 * mode's `webfetch` rule. A `path` reads files, a folder recursively, without the mode's `read` rules,
 * so it is refused even when another field is set too.
 */
function indexVerdict(mode: AgentId, input: unknown): Verdict {
  const call = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const name = MODE_ROLES[mode].name
  if (call.path !== undefined) {
    return {
      effect: "deny",
      reason: `${name} mode refuses \`ctx_index\` with \`path\`: it reads files past the mode's read rules (\`.env\` files need the user's approval); use \`read\``,
    }
  }
  if (typeof call.url === "string" && call.content === undefined) return verdict(mode, permissionEffect(MODE_RULES[mode], "webfetch", call.url), `index ${call.url}`)
  if (typeof call.content === "string" && call.url === undefined) return ALLOW
  return { effect: "deny", reason: "`ctx_index` needs exactly one of `content` or `url` here, so the call cannot be checked" }
}

/** The verdict on `toolName` called with `input` in `mode`. */
export function decideToolCall(mode: AgentId, toolName: string, input: unknown, env: CallEnv): Verdict {
  if (RUNTIME_TOOLS.has(toolName)) return ALLOW
  if (CODE_RUNNING_TOOLS.has(toolName)) {
    return { effect: "deny", reason: `\`${toolName}\` runs code the ${MODE_ROLES[mode].name} mode guard cannot check; use bash` }
  }
  if (!MODE_TOOLS[mode].includes(toolName)) {
    return { effect: "deny", reason: `\`${toolName}\` is not available in ${MODE_ROLES[mode].name} mode` }
  }
  switch (toolName) {
    case "read": {
      const path = (input as { path?: unknown } | null)?.path
      return typeof path === "string" && path !== ""
        ? fileVerdict(mode, "read", path, env)
        : { effect: "deny", reason: "the read has no readable path, so it cannot be checked" }
    }
    case "edit":
    case "write":
      return writeVerdict(mode, toolName, input, env)
    case "bash":
      return shellVerdict(mode, input, env)
    case "subagent":
      return subagentVerdict(mode, input)
    case "ctx_index":
      return indexVerdict(mode, input)
    default:
      return ALLOW
  }
}

/**
 * The mode a pi-subagents child runs as. pi-subagents tags each native child's prompt with
 * `<active_agent name="…"/>` and names its session `<agent>: <label>`; the name is read only for a
 * session with a parent, so a main session the user happens to call "debug: …" stays unguarded by it.
 */
export function childMode(systemPrompt: string, sessionName: string | undefined, hasParent: boolean): AgentId | undefined {
  const tagged = /<active_agent\s+name="([^"]+)"\s*\/>/.exec(systemPrompt)?.[1]
  const named = hasParent ? sessionName?.split(":")[0]?.trim() : undefined
  return AGENT_IDS.find((id) => id === tagged) ?? AGENT_IDS.find((id) => id === named)
}

/**
 * The main session's mode, as `/mode` stores it on the branch. `saved` is the user's own tool list: the
 * tools active before the first mode when a mode is on, and the tools `/mode off` restored when none is.
 */
export type ModeState = { mode?: AgentId; saved?: readonly string[] }

/** What `/mode <choice>` does: the next state, the tools to activate, the modes left and entered, and what to tell the user. */
export type Transition = { state: ModeState; tools?: readonly string[]; left?: AgentId; entered?: AgentId; notice: string }

/** The `/mode` arguments: a mode, or `off`. */
export const MODE_CHOICES: readonly string[] = [...AGENT_IDS, "off"]

/** `/mode <choice>` from `state`, with `active` the tools active now; undefined for an unknown choice. */
export function switchMode(state: ModeState, choice: string, active: readonly string[]): Transition | undefined {
  if (choice === "off") {
    if (state.mode === undefined) return { state, notice: "No mode is active." }
    const tools = state.saved ?? active
    return { state: { saved: tools }, tools, left: state.mode, notice: `Left ${MODE_ROLES[state.mode].name} mode.` }
  }
  const next = AGENT_IDS.find((id) => id === choice)
  if (next === undefined) return undefined
  if (next === state.mode) return { state, notice: `Already in ${MODE_ROLES[next].name} mode.` }
  return {
    // Outside a mode the active tools are the user's own; a mode-to-mode switch keeps the first snapshot.
    state: { mode: next, saved: state.mode === undefined ? [...active] : (state.saved ?? [...active]) },
    tools: MODE_TOOLS[next],
    left: state.mode,
    entered: next,
    notice: `${MODE_ROLES[next].name} mode: other tools are off and the guard checks every call. Leave with /mode off.`,
  }
}

/**
 * The main session's mode after a branch change (`/tree`, resume, reload). `target` is the last `/mode`
 * entry on the new branch, `left` the state on the branch being left, and `earliest` the first tool
 * snapshot the session recorded. A branch with a mode gets that mode's tools and guard. Leaving a mode
 * for a branch without one restores the user's tools: the branch's own `/mode off` snapshot first, since
 * it is what that branch last had, then the snapshot of the mode being left, then the session's tools
 * from before any mode. With no snapshot at all the mode stays on, so its tools never run unguarded.
 */
export function branchMode(target: ModeState, left: ModeState, earliest?: readonly string[]): { state: ModeState; tools?: readonly string[] } {
  if (target.mode !== undefined) return { state: target, tools: MODE_TOOLS[target.mode] }
  if (left.mode === undefined) return { state: target }
  const tools = target.saved ?? left.saved ?? earliest
  return tools === undefined ? { state: left } : { state: { saved: tools }, tools }
}

/** A stored `ModeState`, or the empty state when `data` is not one. */
export function readState(data: unknown): ModeState {
  const value = data !== null && typeof data === "object" ? (data as { mode?: unknown; saved?: unknown }) : {}
  const mode = AGENT_IDS.find((id) => id === value.mode)
  const saved = Array.isArray(value.saved) && value.saved.every((tool) => typeof tool === "string") ? (value.saved as string[]) : undefined
  return { ...(mode === undefined ? {} : { mode }), ...(saved === undefined ? {} : { saved }) }
}

const ALLOWED: Readonly<Record<AgentId, string>> = {
  debug: `a \`debug-<slug>\` worktree under \`~/${PI_SCRATCH.worktrees}/<project>/\`, and \`~/${PI_SCRATCH.ledger}/\``,
  refactor: "source files; never test, fixture or snapshot files",
  concept: "`docs/design/`, `docs/adr/`, `docs/decisions/` and `~/.pi/concept/`",
}

const NEXT: Readonly<Record<AgentId, string>> = {
  debug: "leave with `/mode off` to apply the fix",
  refactor: "leave with `/mode off` for features, bug fixes or test changes",
  concept: "leave with `/mode off`, then plan the work, for example in Plannotator's plan mode",
}

const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`

/** What the main session is told when the user enters `mode` with `/mode`. Static per mode, so the prompt cache holds. */
export function enterReminder(mode: AgentId): string {
  const { name, purpose } = MODE_ROLES[mode]
  return wrap(
    [
      `You are in ${name} mode: ${purpose}`,
      `You may edit files only in: ${ALLOWED[mode]}. The modes extension refuses other writes and every tool outside this mode's list.`,
      `You remain in ${name} mode until the user runs \`/mode off\` or picks another mode. If the user asks for work outside it, do not do it; tell them to ${NEXT[mode]}.`,
    ].join("\n\n"),
  )
}

/** What the main session is told when the user leaves `mode`. */
export function leaveReminder(mode: AgentId): string {
  const { name } = MODE_ROLES[mode]
  return wrap(
    `You are NO LONGER in ${name} mode. The previous ${name} restrictions no longer apply. Any ${name} mode instructions from earlier in this conversation are no longer active.`,
  )
}

/**
 * What `modes_status` reports: the active mode, its tools and where it may write, with pi's roots
 * spelled out. OMP registers no `/mode`, so there the inactive text names the agents instead.
 */
export function statusText(mode: AgentId | undefined, env: CallEnv, host: { omp?: boolean } = {}): string {
  if (mode === undefined)
    return host.omp
      ? "No mode is active. This host has no `/mode` command: launch the `debug`, `refactor` or `concept` agent instead."
      : "No mode is active. The user enters one with `/mode debug`, `/mode refactor` or `/mode concept`."
  const lines = [`${MODE_ROLES[mode].name} mode is active.`, `Tools: ${MODE_TOOLS[mode].join(", ")}.`, `Writes: ${ALLOWED[mode]}.`]
  if (mode === "debug") {
    const project = env.cwd.split(sep).filter(Boolean).pop() ?? "project"
    lines.push(
      `Create the scratch worktree as ${join(env.home, PI_SCRATCH.worktrees, project)}${sep}debug-<slug>, with \`git worktree add --detach <path>\` or \`git worktree add -b debug/<slug> <path>\`.`,
      `Keep the ledger in ${join(env.home, PI_SCRATCH.ledger)}${sep}.`,
    )
  }
  return lines.join("\n")
}
