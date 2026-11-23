/**
 * Read-only Beads preflight checks, the TypeScript twin of
 * `common/skills/beads-preflight/preflight.py`. pi runs it as the `beads_preflight` tool;
 * OpenCode and Claude Code run the script. The check ids, statuses, details, fixes and the
 * report shape are the script's, so the skill's table describes both. Nothing here writes
 * to the ledger.
 */

import { supervise } from "@srobroek/opencode-lib/subprocess"

export const CHECK_IDS = [
  "bd-available",
  "bd-version-supported",
  "store-reachable",
  "store-is-embedded",
  "actor-identity",
  "ready-work-readable",
  "no-stale-lease-on-open-work",
  "remote-sync-configured",
] as const

export type CheckId = (typeof CHECK_IDS)[number]
export type Status = "pass" | "warn" | "fail" | "skip"
export type CheckOutcome = { status: Status; detail: string; fix: string | null }
export type CheckResult = { id: CheckId } & CheckOutcome
export type Report = { ok: boolean; summary: string; checks: CheckResult[] }

// A cold embedded store takes 30-50 s to open, so a shorter bound fails a healthy
// ledger. 60 s covers that with headroom.
export const DEFAULT_TIMEOUT_SECONDS = 60
export const STALE_LEASE_LIMIT = 50
const SETUP_RULE = "see the beads-setup skill"
export const BOOTSTRAP_FIX = "bd bootstrap --yes"
export const INIT_FIX = "bd init --init-if-missing --skip-hooks --skip-agents"
export const REMOTE_FIX = "bd dolt remote add origin git+ssh://git@github.com/OWNER/REPO.git"
export const APPLY_NOTE = "No beads check has a safe automatic fix; --apply performed no mutation."

type Env = Readonly<Record<string, string | undefined>>

/**
 * One finished command. `stdout` and `stderr` are text from a real run; the checks still
 * treat anything else as unreadable rather than throwing.
 */
export type CommandResult = {
  returncode: number
  stdout: string
  stderr: string
  command: readonly string[]
  timeoutSeconds?: number
  timedOut: boolean
}

export function commandResult(
  returncode: number,
  stdout: string,
  stderr: string,
  extra: { command?: readonly string[]; timeoutSeconds?: number; timedOut?: boolean } = {},
): CommandResult {
  return {
    returncode,
    stdout,
    stderr,
    command: extra.command ?? [],
    ...(extra.timeoutSeconds === undefined ? {} : { timeoutSeconds: extra.timeoutSeconds }),
    timedOut: extra.timedOut ?? false,
  }
}

export type PreflightDeps = {
  /** Run one command with `env`: a missing executable is exit 127, a timeout `timedOut` with exit 124. */
  run: (command: readonly string[], timeoutSeconds: number, env: Env) => Promise<CommandResult>
  /** Where `name` resolves on PATH, or `null`. */
  which: (name: string) => string | null
  /** The environment the checks read and the commands start from. */
  env: Env
  now?: () => Date
}

type Version = [number, number, number, string | null]

/** What earlier checks learnt, so later ones reuse it instead of running bd again. */
export type PreflightState = {
  timeoutSeconds?: number
  runStaleLeases?: boolean
  bdAvailable?: boolean
  versionCommand?: CommandResult
  version?: Version | null
  infoCommand?: CommandResult
  infoJson?: unknown
  originCommand?: CommandResult
  readyCommand?: CommandResult
  listCommand?: CommandResult
}

const timeoutFor = (state: PreflightState): number => state.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS

const commandText = (command: CommandResult): string => command.command.join(" ") || "bd command"

/** Python's `{:g}` for the values a timeout takes: no trailing zeros. */
const seconds = (value: number): string => String(Number(value.toPrecision(6)))

function timeoutDetail(command: CommandResult): string {
  const rendered = command.timeoutSeconds === undefined ? "the configured limit" : seconds(command.timeoutSeconds)
  return `${commandText(command)} timed out after ${rendered} seconds`
}

function timeoutResult(command: CommandResult, options: { storeReachable?: boolean; note?: string } = {}): CheckOutcome {
  const detail = options.note ? `${timeoutDetail(command)}; ${options.note}` : timeoutDetail(command)
  return result(options.storeReachable ? "fail" : "warn", detail, "rerun with --timeout SECONDS or inspect the .beads store")
}

/** `bd` with the pager and prompts off, unless the environment already sets them. */
export function runBd(args: readonly string[], timeoutSeconds: number, deps: PreflightDeps): Promise<CommandResult> {
  const env = { ...deps.env }
  env.BD_NO_PAGER ??= "1"
  env.BD_NON_INTERACTIVE ??= "1"
  env.PAGER ??= "cat"
  env.GIT_PAGER ??= "cat"
  return deps.run(["bd", ...args], timeoutSeconds, env)
}

function runGit(args: readonly string[], timeoutSeconds: number, deps: PreflightDeps): Promise<CommandResult> {
  return deps.run(["git", ...args], timeoutSeconds, deps.env)
}

export function detailError(command: CommandResult): string {
  if (command.timedOut) return timeoutDetail(command)
  for (const stream of [command.stderr, command.stdout] as unknown[]) {
    if (typeof stream === "string" && stream.trim() !== "") return stream.trim().replaceAll("\n", " ")
  }
  return `command exited ${command.returncode}`
}

function result(status: Status, detail: string, fix: string | null = null): CheckOutcome {
  return { status, detail, fix }
}

const VERSION =
  /(?<![0-9A-Za-z])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?![0-9A-Za-z.-])/

export function versionFrom(text: unknown): Version | null {
  if (typeof text !== "string") return null
  const match = VERSION.exec(text)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null]
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") throw new TypeError("command output was not text")
  return JSON.parse(text.trim())
}

const isDict = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function rowsFrom(value: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(value)) return value.every(isDict) ? value : null
  if (!isDict(value)) return null
  for (const key of ["items", "issues", "ready", "results", "data"]) {
    const candidate = value[key]
    if (Array.isArray(candidate)) return candidate.every(isDict) ? candidate : null
  }
  if ("id" in value) return [value]
  if (Object.keys(value).length === 0) return []
  return null
}

function firstNonblank(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim() !== "") return value.trim()
  return null
}

function assignedTo(item: Record<string, unknown>): string | null {
  const metadata = isDict(item.metadata) ? item.metadata : {}
  return firstNonblank(
    item.assignee,
    item.assigned_to,
    item.owner,
    metadata.assignee,
    metadata.assigned_to,
    metadata.owner,
  )
}

const EXPIRY_NAMES = new Set([
  "leaseexpiresat",
  "leaseexpiry",
  "leaseexpires",
  "leaseexpiration",
  "leaseexpirationat",
  "leaseuntil",
  "leaseuntilat",
])

/** The first lease-expiry field anywhere in `item`: its raw value and the instant it names. */
export function leaseExpiry(item: unknown): [unknown, Date] | null {
  if (isDict(item)) {
    for (const [key, child] of Object.entries(item)) {
      if (EXPIRY_NAMES.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
        const parsed = parseTimestamp(child)
        if (parsed !== null) return [child, parsed]
      }
      const nested = leaseExpiry(child)
      if (nested !== null) return nested
    }
  } else if (Array.isArray(item)) {
    for (const child of item) {
      const nested = leaseExpiry(child)
      if (nested !== null) return nested
    }
  }
  return null
}

const OFFSET = /(?:[+-]\d{2}(?::?\d{2})?)$/

/** Epoch seconds (or milliseconds) or an ISO 8601 text; a text without an offset is UTC. */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "number") {
    let epoch = value
    if (epoch > 10_000_000_000) epoch /= 1000
    const date = new Date(epoch * 1000)
    return Number.isFinite(date.getTime()) ? date : null
  }
  if (typeof value !== "string" || value.trim() === "") return null
  let text = value.trim().replaceAll("Z", "+00:00")
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:[+-]\d{2}(?::?\d{2})?)?$/.test(text)) return null
  text = text.replace(" ", "T")
  if (text.length > 10 && !OFFSET.test(text)) text += "+00:00"
  const date = new Date(text.length === 10 ? `${text}T00:00:00+00:00` : text)
  return Number.isFinite(date.getTime()) ? date : null
}

/** Python's `shlex.quote`: unchanged when every character is safe, else single-quoted. */
export function shellQuote(value: string): string {
  if (value === "") return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function pathRemedy(directory: string): string {
  return `export PATH=${shellQuote(directory)}":$PATH"`
}

export async function checkBdAvailable(state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  const path = deps.which("bd")
  if (path === null) {
    state.bdAvailable = false
    return result("fail", "bd does not resolve on PATH", pathRemedy("<directory-containing-bd>"))
  }
  const command = await runBd(["--version"], timeoutFor(state), deps)
  state.versionCommand = command
  if (command.timedOut) {
    state.bdAvailable = false
    return timeoutResult(command)
  }
  if (command.returncode !== 0) {
    state.bdAvailable = false
    return result("fail", `bd resolves to ${path}, but bd --version failed: ${detailError(command)}`)
  }
  const version = versionFrom(command.stdout)
  state.version = version
  if (version === null) {
    state.bdAvailable = false
    return result("fail", "bd --version did not contain a parseable semantic version")
  }
  state.bdAvailable = true
  const rendered = command.stdout.trim().split(/\r\n|\r|\n/)[0] ?? ""
  return result("pass", `bd resolves to ${path}; ${rendered}`)
}

export async function checkBdVersionSupported(state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  if (state.versionCommand === undefined) await checkBdAvailable(state, deps)
  const command = state.versionCommand
  if (command?.timedOut) return timeoutResult(command)
  if (!state.bdAvailable) return result("skip", "bd is unavailable, so its version cannot be checked")
  const version = state.version
  if (version === undefined || version === null) return result("fail", "bd --version did not contain a parseable semantic version")
  const [major, minor, patch, prerelease] = version
  const rendered = `${major}.${minor}.${patch}`
  if (prerelease)
    return result("fail", `bd version ${rendered}-${prerelease} is a prerelease; stable 1.3.0 or later is required`)
  if (major < 1 || (major === 1 && minor < 3)) return result("fail", `bd version ${rendered} is older than stable 1.3.0`)
  return result("pass", `bd version ${rendered} is stable and supported`)
}

async function loadInfo(state: PreflightState, deps: PreflightDeps): Promise<[unknown, CommandResult]> {
  if (state.infoCommand !== undefined) return [state.infoJson ?? null, state.infoCommand]
  const command = await runBd(["info", "--json"], timeoutFor(state), deps)
  state.infoCommand = command
  if (command.returncode !== 0) return [null, command]
  let value: unknown
  try {
    value = parseJson(command.stdout)
  } catch {
    return [null, command]
  }
  state.infoJson = value
  return [value, command]
}

const missingDatabase = (command: CommandResult): boolean =>
  detailError(command).toLowerCase().includes("no beads database found")

async function originHasDoltData(state: PreflightState, deps: PreflightDeps): Promise<boolean> {
  let command = state.originCommand
  if (command === undefined) {
    command = await runGit(["ls-remote", "origin", "refs/dolt/data"], timeoutFor(state), deps)
    state.originCommand = command
  }
  if (command.returncode !== 0 || typeof command.stdout !== "string") return false
  return command.stdout
    .split(/\r\n|\r|\n/)
    .map((line) => line.split(/\s+/).filter((field) => field !== ""))
    .some((fields) => fields.length >= 2 && fields[1] === "refs/dolt/data")
}

async function missingDatabaseResult(state: PreflightState, deps: PreflightDeps, command: CommandResult): Promise<CheckOutcome> {
  const detail = `bd info --json failed: ${detailError(command)}; ${SETUP_RULE}`
  if (await originHasDoltData(state, deps)) return result("fail", `${detail}; git origin has refs/dolt/data`, BOOTSTRAP_FIX)
  return result("fail", `${detail}; confirm the git origin first, then initialize the local store`, INIT_FIX)
}

export async function checkStoreReachable(state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  const [value, command] = await loadInfo(state, deps)
  if (command.timedOut) return timeoutResult(command, { storeReachable: true })
  if (command.returncode !== 0) {
    if (missingDatabase(command)) return missingDatabaseResult(state, deps, command)
    return result("fail", `bd info --json failed: ${detailError(command)}`)
  }
  if (!isDict(value)) return result("fail", "bd info --json returned JSON that is not an object")
  const prefix = isDict(value.config) ? value.config.issue_prefix : undefined
  if (typeof prefix !== "string" || prefix.trim() === "") return result("fail", "bd info --json has no config.issue_prefix")
  return result("pass", `store reachable; config.issue_prefix=${prefix.trim()}`)
}

/** Python's `str()` for the JSON values bd reports. */
function pyStr(value: unknown): string {
  if (value === null) return "None"
  if (value === true) return "True"
  if (value === false) return "False"
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return JSON.stringify(value) ?? ""
}

/** `pathlib.Path(text).parts` for a POSIX path. */
function pathParts(text: string): string[] {
  const parts = text.split("/").filter((part) => part !== "" && part !== ".")
  return text.startsWith("/") ? ["/", ...parts] : parts
}

const SERVER_MODES = new Set(["server", "shared", "proxied", "proxy", "sql-server", "global"])
const EMBEDDED_MODES = new Set(["", "direct", "embedded", "local"])

export async function checkStoreEmbedded(state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  const [value, command] = await loadInfo(state, deps)
  if (command.timedOut) return timeoutResult(command)
  if (command.returncode !== 0 || !isDict(value))
    return result("skip", "bd info --json was not available, so store mode cannot be determined")
  const mode = ("mode" in value ? pyStr(value.mode) : "").trim().toLowerCase()
  const databasePath = value.database_path
  const pathText = databasePath === null || databasePath === undefined ? "" : pyStr(databasePath).trim()
  const parts = new Set(pathParts(pathText).map((part) => part.toLowerCase()))
  const config = isDict(value.config) ? value.config : {}
  const serverConfigured = SERVER_MODES.has(mode) || Object.keys(config).some((key) => key.toLowerCase().includes("server"))
  if (serverConfigured)
    return result("warn", `server configuration detected (mode=${mode || "unspecified"}); an embedded .beads store is expected`)
  if (parts.has(".beads") && EMBEDDED_MODES.has(mode))
    return result("pass", `embedded .beads store: yes (mode=${mode || "unspecified"}, database_path=${pathText})`)
  if (pathText || mode)
    return result(
      "warn",
      `embedded .beads store: no or unconfirmed (mode=${mode || "unspecified"}, database_path=${pathText || "unspecified"}); an embedded .beads store is expected`,
    )
  return result("skip", "bd info --json omitted mode and database_path, so store mode cannot be determined")
}

export async function checkActorIdentity(_state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  for (const name of ["BEADS_ACTOR", "BD_ACTOR"]) {
    if ((deps.env[name] ?? "").trim() !== "") return result("pass", `${name} is set`)
  }
  return result(
    "fail",
    "BEADS_ACTOR and BD_ACTOR are both unset or blank",
    "in a main session, export BEADS_ACTOR='your-name'; subagent shells get BD_ACTOR from the beads plugin",
  )
}

export async function checkReadyWork(state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  const command = await runBd(["ready", "--json"], timeoutFor(state), deps)
  state.readyCommand = command
  if (command.timedOut) return timeoutResult(command)
  if (command.returncode !== 0) {
    const fix = missingDatabase(command) ? `see store-reachable remedy (${SETUP_RULE})` : "bd ready --json"
    return result("fail", `bd ready --json failed: ${detailError(command)}`, fix)
  }
  let value: unknown
  try {
    value = parseJson(command.stdout)
  } catch {
    return result("fail", "bd ready --json returned unparseable JSON", "bd ready --json")
  }
  const rows = rowsFrom(value)
  if (rows === null) return result("fail", "bd ready --json returned an unrecognized JSON shape", "bd ready --json")
  return result("pass", `bd ready --json is readable; ${rows.length} ready items returned`)
}

export async function checkStaleLeases(state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  if (!state.runStaleLeases)
    return result(
      "skip",
      "no-stale-lease-on-open-work is opt-in for cost; pass --include-slow or select it with --only no-stale-lease-on-open-work",
    )
  const help = await runBd(["list", "--help"], timeoutFor(state), deps)
  if (help.timedOut) return timeoutResult(help)
  if (help.returncode !== 0)
    return result("skip", `bd list --help failed, so --json and a result bound cannot be verified: ${detailError(help)}`)
  const helpText = `${help.stdout}\n${help.stderr}`
  if (!helpText.includes("--json"))
    return result(
      "skip",
      "bd list --help does not advertise --json; stale leases cannot be inspected and no result bound can be verified",
    )
  const hasLimit = helpText.includes("--limit")
  const limitNote = hasLimit
    ? `capped at ${STALE_LEASE_LIMIT} rows with --limit`
    : "bd list --help advertises no result bound; relies on --timeout"
  const listArgs = ["list", "--status=open", ...(hasLimit ? ["--limit", String(STALE_LEASE_LIMIT)] : []), "--json"]
  const command = await runBd(listArgs, timeoutFor(state), deps)
  state.listCommand = command
  const name = commandText(command)
  if (command.timedOut) return timeoutResult(command, { note: limitNote })
  if (command.returncode !== 0) return result("fail", `${name} failed: ${detailError(command)}; ${limitNote}`, name)
  let value: unknown
  try {
    value = parseJson(command.stdout)
  } catch {
    return result("fail", `${name} returned unparseable JSON; ${limitNote}`, name)
  }
  const rows = rowsFrom(value)
  if (rows === null) return result("fail", `${name} returned an unrecognized JSON shape; ${limitNote}`, name)
  const now = (deps.now ?? (() => new Date()))()
  const stale: Array<[string, unknown]> = []
  for (const row of rows) {
    if (assignedTo(row) === null) continue
    const expiry = leaseExpiry(row)
    if (expiry !== null && expiry[1].getTime() <= now.getTime()) stale.push([pyStr(row.id ?? "unknown"), expiry[0]])
  }
  if (stale.length > 0) {
    const labels = stale.map(([issue, when]) => `${issue} (expired ${pyStr(when)})`).join(", ")
    return result("warn", `stale assigned leases: ${labels}; ${limitNote}`, "bd unclaim <id>")
  }
  return result("pass", `no expired leases among ${rows.length} open beads; ${limitNote}`)
}

const REMOTE_PREFIXES = [
  "http://",
  "https://",
  "ssh://",
  "git://",
  "git@",
  "file://",
  "git+ssh://",
  "git+https://",
  "git+http://",
  "git+file://",
]

export async function checkRemoteSync(state: PreflightState, deps: PreflightDeps): Promise<CheckOutcome> {
  const command = await runBd(["dolt", "remote", "list"], timeoutFor(state), deps)
  if (command.timedOut) return timeoutResult(command)
  if (command.returncode !== 0)
    return result(
      "skip",
      `bd dolt remote list failed; remote configuration cannot be determined read-only: ${detailError(command)}`,
    )
  if (typeof command.stdout !== "string")
    return result("skip", "bd dolt remote list returned non-text output; remote configuration cannot be determined")
  const text = command.stdout.trim()
  if (text === "") return result("skip", "bd dolt remote list returned no output; remote configuration cannot be determined")
  if (text.toLowerCase().replace(/\.+$/, "") === "no remotes configured")
    return result(
      "warn",
      "no Dolt remote configured; bd dolt push exits 0 without pushing when no remote exists",
      REMOTE_FIX,
    )
  for (const line of text.split(/\r\n|\r|\n/).filter((entry) => entry.trim() !== "")) {
    const fields = line.split(/\s+/).filter((field) => field !== "")
    if (fields.length !== 2) return result("skip", "bd dolt remote list returned an unrecognized remote list")
    const [remoteName, remoteUrl] = fields as [string, string]
    if (!/^[A-Za-z0-9._-]+$/.test(remoteName) || !REMOTE_PREFIXES.some((prefix) => remoteUrl.startsWith(prefix)))
      return result("skip", "bd dolt remote list returned an unrecognized remote list")
  }
  return result("pass", "Dolt remote configured: yes")
}

export const CHECKS: Readonly<Record<CheckId, (state: PreflightState, deps: PreflightDeps) => Promise<CheckOutcome>>> = {
  "bd-available": checkBdAvailable,
  "bd-version-supported": checkBdVersionSupported,
  "store-reachable": checkStoreReachable,
  "store-is-embedded": checkStoreEmbedded,
  "actor-identity": checkActorIdentity,
  "ready-work-readable": checkReadyWork,
  "no-stale-lease-on-open-work": checkStaleLeases,
  "remote-sync-configured": checkRemoteSync,
}

export function summary(checks: readonly CheckOutcome[], elapsedSeconds?: number): string {
  const counts: Record<Status, number> = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const check of checks) counts[check.status]++
  const parts = [`${counts.pass} pass`, `${counts.warn} warn`, `${counts.fail} fail`]
  if (counts.skip) parts.push(`${counts.skip} skip`)
  let rendered = parts.join(", ")
  if (elapsedSeconds !== undefined) rendered += `, elapsed ${elapsedSeconds.toFixed(2)}s`
  return rendered
}

export type PreflightOptions = {
  /** Check ids to run, in order; all of them when absent. */
  only?: readonly string[]
  /** Run the opt-in open-bead lease scan. */
  includeSlow?: boolean
  /** Per-command timeout in seconds. */
  timeoutSeconds?: number
}

/** The options' error, as the script's argument parser words it, or `undefined` when they are valid. */
export function optionsError(options: PreflightOptions): string | undefined {
  const timeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  if (!Number.isFinite(timeout) || timeout <= 0) return "--timeout must be a finite number greater than zero"
  if (options.only === undefined) return undefined
  const unknown = options.only
    .map((item) => item.trim())
    .filter((item) => item !== "" && !(CHECK_IDS as readonly string[]).includes(item))
  return unknown.length > 0 ? `unknown check id(s): ${unknown.join(", ")}` : undefined
}

/** Run the selected checks in order. Throws the {@link optionsError} for invalid options. */
export async function runPreflight(options: PreflightOptions, deps: PreflightDeps): Promise<Report> {
  const started = performance.now()
  const invalid = optionsError(options)
  if (invalid !== undefined) throw new Error(invalid)
  const selected = (
    options.only === undefined ? [...CHECK_IDS] : options.only.map((item) => item.trim()).filter((item) => item !== "")
  ) as CheckId[]
  const state: PreflightState = {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    runStaleLeases: options.includeSlow === true || (options.only !== undefined && selected.includes("no-stale-lease-on-open-work")),
  }
  const checks: CheckResult[] = []
  for (const id of selected) checks.push({ id, ...(await CHECKS[id](state, deps)) })
  return {
    ok: !checks.some((check) => check.status === "fail"),
    summary: summary(checks, (performance.now() - started) / 1000),
    checks,
  }
}

/**
 * Run `command` in `cwd` as the script's `subprocess.run` does: stdout and stderr captured as
 * text with invalid UTF-8 replaced, the executable looked up on `env`'s PATH, killed at the deadline.
 */
export async function runCommand(
  command: readonly string[],
  timeoutSeconds: number,
  env: Env,
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  const [name = "", ...args] = command
  const extra = { command, timeoutSeconds }
  const executable = name === "" ? null : Bun.which(name, { PATH: env.PATH ?? "" })
  if (executable === null) return commandResult(127, "", `${name} was not found on PATH`, extra)
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([executable, ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    return commandResult(127, "", `${name} was not found on PATH`, extra)
  }
  const run = await supervise(child, { timeoutMs: timeoutSeconds * 1000, signal: options.signal })
  if (run.kind === "timeout") return commandResult(124, "", "", { ...extra, timedOut: true })
  if (run.kind === "exited") return commandResult(run.exitCode, run.stdout, run.stderr, extra)
  const why = run.kind === "aborted" ? "the check was cancelled" : "the command ended without reporting an exit status"
  return commandResult(1, run.stdout, run.stderr === "" ? why : run.stderr, extra)
}

/** The deps that run real commands in `cwd`, reading and starting from `env`. */
export function systemDeps(env: Env, cwd: string, signal?: AbortSignal): PreflightDeps {
  return {
    env,
    run: (command, timeoutSeconds, runEnv) => runCommand(command, timeoutSeconds, runEnv, { cwd, signal }),
    which: (name) => Bun.which(name, { PATH: env.PATH ?? "" }),
  }
}
