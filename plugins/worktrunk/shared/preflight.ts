/**
 * Worktrunk preflight checks for linked-worktree runs: the TypeScript port of
 * `common/skills/worktrunk-preflight/preflight.py`, with the same check ids, statuses,
 * details and fixes, and the same `{ ok, summary, checks }` report. Read-only unless
 * `apply` is set. Commands run without a shell; nothing here evaluates shell text.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { shellQuoteBalanced, tokenizeShell } from "@srobroek/opencode-lib"
import { supervise } from "@srobroek/opencode-lib/subprocess"
import { parse as parseToml } from "smol-toml"

export const APPROVALS_FIX = "wt config approvals add --yes"
export const MERGE_FIX = "wt merge --no-squash --no-ff"
export const WORKTREE_FIX = "wt switch -y --create --no-cd --base <base-commit> --format json <branch>"
export const PROVISIONING_COPY_COMMAND = "wt step copy-ignored --require-include"
export const PROVISIONING_UV_COMMAND = "uv sync"
export const PROVISIONING_FIX =
  "rerun with --apply; project hooks require `wt config approvals add` before the next worktree"

const DEFAULT_TIMEOUT_MS = 60_000

export type Status = "pass" | "warn" | "fail" | "skip"
export type Result = { status: Status; detail: string; fix: string | null }
export type CheckReport = { id: string; status: Status; detail: string; fix: string | null }
export type Report = { ok: boolean; summary: string; checks: CheckReport[] }

function result(status: Status, detail: string, fix: string | null = null): Result {
  return { status, detail, fix }
}

/** A finished command. `returncode` is `null` when it could not run or timed out, with `error` saying why. */
export type CommandResult = { returncode: number | null; stdout: string; stderr: string; error?: string }

export function commandResult(returncode: number | null, stdout = "", stderr = "", error?: string): CommandResult {
  return error === undefined ? { returncode, stdout, stderr } : { returncode, stdout, stderr, error }
}

function nonText(value: unknown): string {
  return `<non-text ${Array.isArray(value) ? "list" : typeof value} output>`
}

/** stdout and stderr joined; a stream that is not text is named, not rendered. */
export function commandOutput(command: CommandResult): string {
  const streams: string[] = []
  for (const stream of [command.stdout, command.stderr] as unknown[]) {
    if (typeof stream === "string") {
      if (stream) streams.push(stream)
    } else if (stream !== null && stream !== undefined) streams.push(nonText(stream))
  }
  return streams.join("\n")
}

export type RunOptions = { cwd?: string; timeoutMs?: number; useCache?: boolean }

/** What a check reads. `Context` is the real one; tests supply their own. */
export interface PreflightContext {
  readonly cwd: string
  /** The home directory whose `~/.config/worktrunk/config.toml` is the user config. */
  readonly home: string
  ignoredConfigKeys: string[]
  readonly gitRootError?: string | undefined
  run(args: readonly string[], options?: RunOptions): Promise<CommandResult>
  requireGitRoot(): Promise<string | undefined>
  /** Run `write`, the whole read-modify-write of `path`, under the host's file lock. */
  mutateFile(path: string, write: () => void): Promise<void>
}

export type Spawn = (args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandResult>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run `args` without a shell; never throws. */
export const spawnCommand: Spawn = async (args, cwd, timeoutMs) => {
  const label = args.join(" ")
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
  try {
    child = Bun.spawn([...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return code === "ENOENT"
      ? commandResult(null, "", "", `command not found: ${args[0]} (${errorMessage(error)})`)
      : commandResult(null, "", "", `could not run ${label}: ${errorMessage(error)}`)
  }
  const run = await supervise(child, { timeoutMs })
  if (run.kind === "exited") return commandResult(run.exitCode, run.stdout, run.stderr)
  if (run.kind === "timeout") return commandResult(null, "", "", `timed out after ${timeoutMs / 1000}s: ${label}`)
  return commandResult(null, "", "", `could not run ${label}: ${run.kind}`)
}

export function firstNonemptyLine(text: unknown): string {
  if (typeof text !== "string") return ""
  for (const line of text.split(/\r?\n|\r/)) if (line.trim()) return line.trim()
  return ""
}

export function oneLine(text: unknown): string {
  if (typeof text !== "string") return text === null || text === undefined ? "" : nonText(text)
  return text.split(/\s+/).filter(Boolean).join(" ")
}

export function commandError(command: CommandResult, label: string): string {
  if (command.error) return command.error
  const output = oneLine(commandOutput(command))
  return output ? `${label} failed (${command.returncode}): ${output}` : `${label} failed (${command.returncode})`
}

function unavailable(command: CommandResult): boolean {
  return command.returncode === null
}

/** `path` made absolute and, where it exists, with symlinks resolved (Python's `Path.resolve()`). */
function resolvePath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export type ContextOptions = { home?: string; spawn?: Spawn; mutateFile?: PreflightContext["mutateFile"] }

export class Context implements PreflightContext {
  readonly cwd: string
  readonly home: string
  ignoredConfigKeys: string[] = []
  gitRootError: string | undefined
  #gitRoot: string | undefined
  readonly #cache = new Map<string, CommandResult>()
  readonly #spawn: Spawn
  readonly #mutateFile: PreflightContext["mutateFile"]

  constructor(cwd: string, options: ContextOptions = {}) {
    this.cwd = cwd
    this.home = options.home ?? homedir()
    this.#spawn = options.spawn ?? spawnCommand
    this.#mutateFile = options.mutateFile ?? (async (_path, write) => write())
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    const useCache = options.useCache ?? true
    const key = JSON.stringify([args, options.cwd ?? null])
    const cached = useCache ? this.#cache.get(key) : undefined
    if (cached !== undefined) return cached
    const found = await this.#spawn(args, options.cwd ?? this.cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (useCache) this.#cache.set(key, found)
    return found
  }

  async requireGitRoot(): Promise<string | undefined> {
    if (this.#gitRoot !== undefined || this.gitRootError !== undefined) return this.#gitRoot
    const found = await this.run(["git", "rev-parse", "--show-toplevel"])
    const root = firstNonemptyLine(found.stdout)
    if (found.returncode === 0 && root) this.#gitRoot = resolvePath(root)
    else this.gitRootError = commandError(found, "git rev-parse --show-toplevel")
    return this.#gitRoot
  }

  mutateFile(path: string, write: () => void): Promise<void> {
    return this.#mutateFile(path, write)
  }
}

/**
 * Plain `wt config show` already reports `[commit.generation]`. `--full` adds a live
 * commit-generation probe that calls the configured LLM (~30 s and a paid request).
 */
function fullConfig(ctx: PreflightContext): Promise<CommandResult> {
  return ctx.run(["wt", "config", "show"])
}

export async function checkWtAvailable(ctx: PreflightContext): Promise<Result> {
  const found = await ctx.run(["wt", "--version"])
  if (found.returncode === 0) {
    if (typeof found.stdout !== "string" || typeof found.stderr !== "string")
      return result("fail", "wt --version returned non-text output")
    const rendered = oneLine(found.stdout || found.stderr)
    return rendered ? result("pass", rendered) : result("fail", "wt --version returned no output")
  }
  if (unavailable(found)) return result("fail", "wt is absent from PATH")
  return result("fail", commandError(found, "wt --version"))
}

export async function checkInsideGitRepo(ctx: PreflightContext): Promise<Result> {
  const root = await ctx.requireGitRoot()
  if (root !== undefined) return result("pass", `git repository root is ${root}`)
  return result("fail", ctx.gitRootError || "git repository root could not be determined")
}

function resolveGitPath(raw: string, cwd: string): string {
  return resolvePath(isAbsolute(raw) ? raw : join(cwd, raw))
}

export async function checkCwdIsWorktree(ctx: PreflightContext): Promise<Result> {
  const gitDir = await ctx.run(["git", "rev-parse", "--git-dir"])
  const commonDir = await ctx.run(["git", "rev-parse", "--git-common-dir"])
  const gitRaw = firstNonemptyLine(gitDir.stdout)
  const commonRaw = firstNonemptyLine(commonDir.stdout)
  if (gitDir.returncode !== 0 || commonDir.returncode !== 0 || !gitRaw || !commonRaw) {
    const details = [
      gitDir.returncode !== 0 ? commandError(gitDir, "git rev-parse --git-dir") : undefined,
      commonDir.returncode !== 0 ? commandError(commonDir, "git rev-parse --git-common-dir") : undefined,
    ]
      .filter(Boolean)
      .join("; ")
    return result("fail", details || "git directory topology could not be determined")
  }
  const gitPath = resolveGitPath(gitRaw, ctx.cwd)
  const commonPath = resolveGitPath(commonRaw, ctx.cwd)
  if (gitPath === commonPath) {
    const root = (await ctx.requireGitRoot()) ?? ctx.cwd
    return result("warn", `cwd is the canonical checkout (${root}); work belongs in a linked worktree`, WORKTREE_FIX)
  }
  return result("pass", `cwd is a linked worktree (git-dir ${gitPath}; common-dir ${commonPath})`)
}

/** The JSON object that `text` ends with, starting at its first `{` that parses. */
export function parseJsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined
  for (let index = text.indexOf("{"); index !== -1; index = text.indexOf("{", index + 1)) {
    try {
      const value: unknown = JSON.parse(text.slice(index))
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // Not a complete object from here; try the next brace.
    }
  }
  return undefined
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function isPathToken(token: string): boolean {
  return /^(?:\/|\.\/|\.\.\/|~\/)/.test(token) || (token.includes("/") && !token.startsWith("-"))
}

function resolvePathToken(token: string, ctx: PreflightContext): string {
  const expanded = token.startsWith("~/") ? join(ctx.home, token.slice(2)) : token
  return resolvePath(isAbsolute(expanded) ? expanded : join(ctx.cwd, expanded))
}

/** The words of `command`, shlex-style; `undefined` for an unterminated quote. */
function shellWords(command: string): string[] | undefined {
  if (!shellQuoteBalanced(command)) return undefined
  return tokenizeShell(command).map((token) => token.value)
}

/** The hook command's words after leading assignments; `wt config approvals list` names it `template`. */
function commandWords(command: Record<string, unknown>): string[] | undefined {
  const raw = command.template
  if (typeof raw !== "string" || !raw.trim()) return undefined
  const tokens = shellWords(raw)
  if (tokens === undefined || tokens.length === 0) return undefined
  let index = 0
  while (index < tokens.length && ASSIGNMENT.test(tokens[index] as string)) index++
  return index < tokens.length ? tokens.slice(index) : undefined
}

/** The hook's executable word and the file it runs, `null` when it is not on `PATH`. */
export function resolveHookExecutable(
  command: Record<string, unknown>,
  ctx: PreflightContext,
): { executable: string; path: string | null } | undefined {
  const words = commandWords(command)
  if (words === undefined) return undefined
  const executable = words[0] as string
  if (isPathToken(executable)) return { executable, path: resolvePathToken(executable, ctx) }
  const found = Bun.which(executable)
  return { executable, path: found ? resolvePath(found) : null }
}

/** The path-shaped arguments of the hook, such as an interpreter's script. */
export function declaredHookPaths(command: Record<string, unknown>, ctx: PreflightContext): string[] {
  const words = commandWords(command)
  if (words === undefined) return []
  const paths: string[] = []
  for (const word of words.slice(1)) {
    if (!isPathToken(word)) continue
    const path = resolvePathToken(word, ctx)
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode)
    return true
  } catch {
    return false
  }
}

/** JSON with sorted keys, as the Python report renders stale approvals. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
}

export async function checkHookApprovals(ctx: PreflightContext, fresh = false): Promise<Result> {
  const found = await ctx.run(["wt", "config", "approvals", "list", "--format=json"], { useCache: !fresh })
  if (found.returncode !== 0) {
    if (unavailable(found)) return result("skip", "wt is unavailable; hook approvals cannot be inspected")
    return result("fail", commandError(found, "wt config approvals list --format=json"))
  }
  if (typeof found.stdout !== "string" || typeof found.stderr !== "string")
    return result("fail", "Worktrunk approvals command returned non-text output")
  const data = parseJsonObject(commandOutput(found))
  if (data === undefined) return result("fail", "Worktrunk returned no parseable approvals JSON")

  const state = data.state
  const commands = data.commands
  if (!Array.isArray(commands)) return result("fail", "Worktrunk approvals JSON omitted a valid commands list")
  if (commands.some((command) => command === null || typeof command !== "object" || Array.isArray(command)))
    return result("fail", "Worktrunk approvals JSON contained a malformed command row")
  const unapproved: string[] = []
  const missing: string[] = []
  const nonExecutable: string[] = []
  const unreadable: string[] = []
  for (const command of commands as Record<string, unknown>[]) {
    const label = `${String(command.phase ?? "?")}/${String(command.name ?? "?")}`
    if (command.approved === false) unapproved.push(label)
    const resolved = resolveHookExecutable(command, ctx)
    if (resolved === undefined) {
      missing.push(`${label} (missing or invalid command)`)
      continue
    }
    if (resolved.path === null) missing.push(`${label} (command '${resolved.executable}' not found on PATH)`)
    else if (!isFile(resolved.path)) missing.push(`${label} (${resolved.path})`)
    else if (!canAccess(resolved.path, constants.X_OK)) nonExecutable.push(`${label} (${resolved.path})`)
    for (const path of declaredHookPaths(command, ctx)) {
      if (!isFile(path)) missing.push(`${label} (${path})`)
      else if (!canAccess(path, constants.R_OK)) unreadable.push(`${label} (${path})`)
    }
  }

  const staleItems = Array.isArray(data.stale) ? data.stale : []
  const staleDetail = staleItems.length > 0 ? `; stale entries: ${oneLine(sortedJson(staleItems))}` : ""
  let hookDetail = ""
  if (missing.length > 0) hookDetail += `; missing hook executables: ${missing.join(", ")}`
  if (nonExecutable.length > 0) hookDetail += `; non-executable hook files: ${nonExecutable.join(", ")}`
  if (unreadable.length > 0) hookDetail += `; unreadable hook scripts: ${unreadable.join(", ")}`
  if (hookDetail) return result("fail", `declared hook verification failed${hookDetail}`)
  if (state === "approval_required") {
    const names = unapproved.length > 0 ? unapproved.join(", ") : "unlisted commands"
    return result("fail", `approval_required; unapproved project hooks: ${names}${staleDetail}`, APPROVALS_FIX)
  }
  if (state === "no_commands" || state === "approved") {
    if (staleItems.length > 0) return result("warn", `state=${state}; no unapproved hooks${staleDetail}`)
    return result("pass", `state=${state}; declared hooks present, executable, and approved`)
  }
  return result("fail", `unrecognized approvals state ${pythonRepr(state)}${staleDetail}`)
}

function pythonRepr(value: unknown): string {
  if (value === undefined || value === null) return "None"
  return typeof value === "string" ? `'${value}'` : JSON.stringify(value)
}

export function ignoredConfigKeys(text: string): string[] {
  const pattern = /\bkey\s+([A-Za-z0-9_.-]+)\s+which belongs in user config \(will be ignored\)/gi
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] as string))]
}

export async function checkConfigKeys(ctx: PreflightContext): Promise<Result> {
  const found = await ctx.run(["wt", "config", "show"])
  const keys = ignoredConfigKeys(commandOutput(found))
  ctx.ignoredConfigKeys = keys
  if (keys.length > 0) {
    return result(
      "fail",
      `ignored project-config key(s): ${keys.join(", ")}`,
      'Move the setting to ~/.config/worktrunk/config.toml, optionally scoped under [projects."<id>"]',
    )
  }
  if (found.returncode === 0) return result("pass", "no project-config keys are being discarded")
  if (unavailable(found)) return result("skip", "wt is unavailable; config warnings cannot be inspected")
  return result("skip", commandError(found, "wt config show"))
}

export async function checkDefaultBranch(ctx: PreflightContext): Promise<Result> {
  const found = await ctx.run(["wt", "config", "state", "default-branch"])
  const branch = oneLine(found.stdout)
  if (found.returncode === 0 && branch) return result("pass", `default branch is ${branch}`)
  if (unavailable(found)) return result("skip", "wt is unavailable; default branch cannot be resolved")
  return result("fail", commandError(found, "wt config state default-branch"))
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** The raw `key = value` lines of one `[section]` of a TOML-like file. */
export function parseSection(path: string, wanted: string): Record<string, string> {
  const values: Record<string, string> = {}
  const text = readText(path)
  if (text === undefined) return values
  let section: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith("#")) continue
    const sectionMatch = /^\[([^\]]+)\]$/.exec(stripped)
    if (sectionMatch) {
      section = (sectionMatch[1] as string).trim()
      continue
    }
    if (section !== wanted) continue
    const keyMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(stripped)
    if (keyMatch) values[keyMatch[1] as string] = keyMatch[2] as string
  }
  return values
}

/** `host/path` of `remote.origin.url`, the id Worktrunk's `[projects."<id>"]` uses. */
export async function repositoryProjectId(ctx: PreflightContext): Promise<string | undefined> {
  const found = await ctx.run(["git", "config", "--get", "remote.origin.url"])
  let remote = firstNonemptyLine(found.stdout)
  if (found.returncode !== 0 || !remote) return undefined
  if (remote.startsWith("git@") && remote.includes(":")) {
    const [host, ...path] = remote.slice(4).split(":")
    remote = `${host}/${path.join(":")}`
  } else {
    remote = remote.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "")
  }
  remote = (remote.split("?", 1)[0] as string).split("#", 1)[0]?.replace(/\/+$/, "") ?? ""
  if (remote.endsWith(".git")) remote = remote.slice(0, -4)
  return remote || undefined
}

function projectMergeValues(path: string, projectId: string | undefined): Record<string, string> {
  if (projectId === undefined) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseSection(path, `projects."${projectId}"`))) {
    const name = key.startsWith("merge.") ? key.slice("merge.".length) : key
    if (name === "squash" || name === "ff") out[name] = value
  }
  return out
}

/** Python's `fnmatch.fnmatchcase`: `*` and `?` also match `/`. */
export function fnmatchCase(name: string, pattern: string): boolean {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string
    if (char === "*") source += ".*"
    else if (char === "?") source += "."
    else if (char === "[") {
      let j = i + 1
      if (pattern[j] === "!") j++
      if (pattern[j] === "]") j++
      while (j < pattern.length && pattern[j] !== "]") j++
      if (j >= pattern.length) source += "\\["
      else {
        let set = pattern.slice(i + 1, j).replaceAll("\\", "\\\\")
        if (set.startsWith("!")) set = `^${set.slice(1)}`
        else if (set.startsWith("^")) set = `\\${set}`
        source += `[${set}]`
        i = j
      }
    } else source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  }
  return new RegExp(`^${source}$`, "s").test(name)
}

export function includeCoversDependency(pattern: string, dependency: string): boolean {
  let normalized = pattern.trim()
  if (!normalized || normalized.startsWith("#") || normalized.startsWith("!")) return false
  normalized = normalized.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
  if (normalized.startsWith("**/")) normalized = normalized.slice(3)
  return [dependency, `${dependency}/`, `${dependency}/placeholder`].some((candidate) => fnmatchCase(candidate, normalized))
}

function formatValues(values: Record<string, string>): string {
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.length === 0 ? "no [merge] keys" : entries.map(([key, value]) => `${key}=${value}`).join(", ")
}

function userConfigPath(ctx: PreflightContext): string {
  return join(ctx.home, ".config", "worktrunk", "config.toml")
}

export async function checkMergeEvidence(ctx: PreflightContext): Promise<Result> {
  const root = await ctx.requireGitRoot()
  if (root === undefined) return result("skip", "git repository root is unavailable; merge policy cannot be inspected")
  let projectValues = parseSection(join(root, ".config", "wt.toml"), "merge")
  // wt's warning remains authoritative when a config was changed between reads.
  if (Object.keys(projectValues).length === 0 && ctx.ignoredConfigKeys.includes("merge"))
    projectValues = { merge: "declared by Worktrunk warning" }
  const userPath = userConfigPath(ctx)
  const projectId = await repositoryProjectId(ctx)
  const scopedValues = projectMergeValues(userPath, projectId)
  const userValues = { ...parseSection(userPath, "merge"), ...scopedValues }
  let userDetail = `user config: ${formatValues(userValues)}`
  if (Object.keys(scopedValues).length > 0) userDetail += ` (project ${projectId})`
  const invocationDetail =
    "Reliable control: explicit wt merge --no-squash --no-ff on every worker-to-epic merge; " +
    "an epic-to-default merge may be plain or squashing."
  if (Object.keys(projectValues).length > 0) {
    return result(
      "fail",
      `project config [merge] keys are ignored (${formatValues(projectValues)}); ${userDetail}. ${invocationDetail}`,
      MERGE_FIX,
    )
  }
  const squash = (userValues.squash ?? "").trim().toLowerCase()
  const ff = (userValues.ff ?? "").trim().toLowerCase()
  if (squash === "false" && ff === "false")
    return result("pass", `${userDetail}; merge evidence is configured. ${invocationDetail}`)
  return result("warn", `${userDetail}; merge evidence is not guaranteed. ${invocationDetail}`, MERGE_FIX)
}

async function ignoredProvisioningDirs(
  ctx: PreflightContext,
  root: string,
): Promise<{ ignored: string[]; error?: string }> {
  const ignored: string[] = []
  for (const dependency of ["node_modules", "target", ".venv"]) {
    const found = await ctx.run(["git", "check-ignore", "-q", dependency], { cwd: root })
    if (found.returncode === 0) ignored.push(dependency)
    else if (found.returncode !== 1) return { ignored: [], error: commandError(found, `git check-ignore -q ${dependency}`) }
  }
  return { ignored }
}

type Phase = "pre-start" | "post-start"
type HookCommands = Record<Phase, string[]>
const PHASES: readonly Phase[] = ["pre-start", "post-start"]

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function hookCommandsFromToml(data: Record<string, unknown>, phase: Phase): string[] {
  const value = data[phase]
  if (typeof value === "string") return [value]
  const items: unknown[] = Array.isArray(value) ? value : [value]
  const tables = items.flatMap((item): Record<string, unknown>[] => {
    const table = record(item)
    return table === undefined ? [] : [table]
  })
  return tables.flatMap((table) => Object.values(table).filter((command): command is string => typeof command === "string"))
}

function parseTomlFile(path: string): Record<string, unknown> | undefined {
  const text = readText(path)
  if (text === undefined) return undefined
  try {
    return parseToml(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function hookCommandsFromTomlFile(path: string): HookCommands {
  const data = parseTomlFile(path)
  if (data === undefined) return { "pre-start": [], "post-start": [] }
  return { "pre-start": hookCommandsFromToml(data, "pre-start"), "post-start": hookCommandsFromToml(data, "post-start") }
}

/** Hook commands in `wt config show` output: only its `[post-start]` table and `[[post-start]]` pipeline forms. */
export function hookCommandsFromConfigOutput(text: string): HookCommands {
  const commands: HookCommands = { "pre-start": [], "post-start": [] }
  let phase: Phase | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const section = /^\[\[?(pre-start|post-start)\]\]?$/.exec(line)
    if (section) {
      phase = section[1] as Phase
      continue
    }
    if (line.startsWith("[")) {
      phase = undefined
      continue
    }
    if (phase === undefined || !line || line.startsWith("#")) continue
    const keyValue = /^[A-Za-z0-9_-]+\s*=\s*(.+)$/.exec(line)
    if (!keyValue) continue
    try {
      const value = (parseToml(`value = ${keyValue[1]}`) as Record<string, unknown>).value
      if (typeof value === "string") commands[phase].push(value)
    } catch {
      // Not a TOML value; skip the line.
    }
  }
  return commands
}

async function effectiveHookCommands(ctx: PreflightContext, root: string): Promise<HookCommands> {
  const commands: HookCommands = { "pre-start": [], "post-start": [] }
  for (const path of [userConfigPath(ctx), join(root, ".config", "wt.toml")]) {
    const found = hookCommandsFromTomlFile(path)
    for (const phase of PHASES) commands[phase].push(...found[phase])
  }
  if (commands["post-start"].length === 0) {
    const found = await ctx.run(["wt", "config", "show"])
    if (found.returncode === 0) {
      const rendered = hookCommandsFromConfigOutput(commandOutput(found))
      for (const phase of PHASES) commands[phase].push(...rendered[phase])
    }
  }
  return commands
}

/** Whether `command` runs `executable` followed, anywhere later, by `words`. */
export function hookRuns(command: string, executable: string, words: readonly string[]): boolean {
  const tokens = shellWords(command)
  if (tokens === undefined) return false
  return tokens.some(
    (token, index) =>
      token === executable &&
      tokens.some(
        (_word, offset) =>
          offset > index && offset + words.length <= tokens.length && words.every((word, k) => tokens[offset + k] === word),
      ),
  )
}

function uvSyncNeeded(root: string): boolean {
  if (!isFile(join(root, "pyproject.toml"))) return false
  if (isFile(join(root, "uv.lock"))) return true
  return record(record(parseTomlFile(join(root, "pyproject.toml"))?.tool)?.uv) !== undefined
}

type ProvisioningState = {
  needsCopy: boolean
  needsUv: boolean
  missing: string[]
  preStart: string[]
  postStart: string[]
  error?: string
}

async function provisioningHookState(ctx: PreflightContext, root: string): Promise<ProvisioningState> {
  const { ignored, error } = await ignoredProvisioningDirs(ctx, root)
  if (error !== undefined) return { needsCopy: false, needsUv: false, missing: [], preStart: [], postStart: [], error }
  const needsCopy = ignored.length > 0 || existsSync(join(root, ".worktreeinclude"))
  const needsUv = uvSyncNeeded(root)
  const required: [string, string, string[]][] = []
  if (needsCopy) required.push(["copy-ignored", "wt", ["step", "copy-ignored"]])
  if (needsUv) required.push(["uv sync", "uv", ["sync"]])
  const hooks = await effectiveHookCommands(ctx, root)
  const state: ProvisioningState = { needsCopy, needsUv, missing: [], preStart: [], postStart: [] }
  for (const [name, executable, words] of required) {
    if (hooks["post-start"].some((command) => hookRuns(command, executable, words))) state.postStart.push(name)
    else if (hooks["pre-start"].some((command) => hookRuns(command, executable, words))) state.preStart.push(name)
    else state.missing.push(name)
  }
  return state
}

export function provisioningHookBlock(needsCopy: boolean, needsUv: boolean): string {
  const lines = ["[post-start]"]
  if (needsCopy) lines.push(`copy-ignored = "${PROVISIONING_COPY_COMMAND}"`)
  if (needsUv) lines.push(`deps = "${PROVISIONING_UV_COMMAND}"`)
  return `${lines.join("\n")}\n`
}

/** `existing` with `block` merged into its `[post-start]` table, or appended; existing text is kept. */
export function appendProvisioningHook(existing: string, block: string): string {
  const table = /^[ \t]*\[post-start\][ \t]*$/m.exec(existing)
  const array = /^[ \t]*\[\[post-start\]\][ \t]*$/m.test(existing)
  const lines = block.split("\n").filter((line) => line && !line.startsWith("[post-start]"))
  if (table && !array) {
    const tableEnd = table.index + table[0].length
    const rest = existing.slice(tableEnd)
    const next = /^[ \t]*\[\[?[^\]]+\]\]?[ \t]*$/m.exec(rest)
    let insertion = lines.map((line) => `${line}\n`).join("")
    const position = tableEnd + (next ? next.index : rest.length)
    if (position && existing[position - 1] !== "\n") insertion = `\n${insertion}`
    return existing.slice(0, position) + insertion + existing.slice(position)
  }
  const appended = array ? block.replace("[post-start]", "[[post-start]]") : block
  const separator = !existing || existing.endsWith("\n") ? "" : "\n"
  return existing + separator + (!existing || existing.endsWith("\n\n") ? "" : "\n") + appended
}

export async function checkProvisioningHook(ctx: PreflightContext): Promise<Result> {
  const root = await ctx.requireGitRoot()
  if (root === undefined) return result("skip", "git repository root is unavailable; provisioning hooks cannot be inspected")
  const state = await provisioningHookState(ctx, root)
  if (state.error !== undefined) return result("skip", state.error)
  if (!state.needsCopy && !state.needsUv)
    return result("pass", "no ignored dependency/build directories, .worktreeinclude, or uv project needs provisioning")
  if (state.missing.length > 0) {
    const block = provisioningHookBlock(
      state.needsCopy && state.missing.includes("copy-ignored"),
      state.needsUv && state.missing.includes("uv sync"),
    )
    return result(
      "fail",
      `missing post-start provisioning hook(s): ${state.missing.join(", ")}; add this TOML to .config/wt.toml:\n${block.trimEnd()}`,
      PROVISIONING_FIX,
    )
  }
  const details: string[] = []
  if (state.postStart.length > 0) details.push(`post-start hooks run in the background for ${state.postStart.join(", ")}`)
  if (state.preStart.length > 0) details.push(`pre-start hooks cover ${state.preStart.join(", ")} and block worktree creation`)
  return result("pass", details.join("; "))
}

export async function fixProvisioningHook(ctx: PreflightContext): Promise<Result> {
  const root = await ctx.requireGitRoot()
  if (root === undefined) return result("skip", "git repository root is unavailable; provisioning hooks cannot be fixed")
  const state = await provisioningHookState(ctx, root)
  if (state.error !== undefined) return result("skip", state.error)
  if (state.missing.length === 0) return checkProvisioningHook(ctx)
  const path = join(root, ".config", "wt.toml")
  const block = provisioningHookBlock(
    state.needsCopy && state.missing.includes("copy-ignored"),
    state.needsUv && state.missing.includes("uv sync"),
  )
  try {
    await ctx.mutateFile(path, () => {
      let existing = ""
      if (existsSync(path)) {
        try {
          existing = readFileSync(path, "utf8")
        } catch (error) {
          throw new Error(`cannot read ${path}: ${errorMessage(error)}`)
        }
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, appendProvisioningHook(existing, block), "utf8")
    })
  } catch (error) {
    return result("fail", errorMessage(error), PROVISIONING_FIX)
  }
  return result(
    "pass",
    `added missing provisioning hooks to ${path}; project hooks need \`wt config approvals add\` before the next worktree`,
  )
}

export async function checkProvisioningInclude(ctx: PreflightContext): Promise<Result> {
  const root = await ctx.requireGitRoot()
  if (root === undefined)
    return result("skip", "git repository root is unavailable; ignored dependencies cannot be inspected")
  const { ignored, error } = await ignoredProvisioningDirs(ctx, root)
  if (error !== undefined) return result("skip", error)
  const include = join(root, ".worktreeinclude")
  if (ignored.length > 0 && !existsSync(include)) {
    return result(
      "warn",
      `ignored dependency directories: ${ignored.join(", ")}; no .worktreeinclude exists. A fresh worktree will fail a focused test run with a missing-module error that reads as broken code`,
      "wt step copy-ignored",
    )
  }
  if (ignored.length > 0) {
    const patterns = readText(include)?.split(/\r?\n/)
    if (patterns === undefined) {
      return result(
        "warn",
        `.worktreeinclude exists but cannot be read; ignored dependency directories: ${ignored.join(", ")}`,
        "repair .worktreeinclude, then run wt step copy-ignored",
      )
    }
    const missing = ignored.filter((dependency) => !patterns.some((pattern) => includeCoversDependency(pattern, dependency)))
    if (missing.length > 0) {
      return result(
        "warn",
        `ignored dependency directories not matched by ${include}: ${missing.join(", ")}; a fresh worktree may have incomplete dependencies`,
        "add matching <directory>/ patterns to .worktreeinclude, then run wt step copy-ignored",
      )
    }
    return result("pass", `ignored dependency directories ${ignored.join(", ")} are covered by ${include}`)
  }
  return result("pass", "node_modules, target, and .venv are not ignored dependency directories")
}

const BUN_INSTALL_FIX = "bun install --frozen-lockfile, then rerun the Worktrunk preflight"

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function checkNodeModulesIntegrity(ctx: PreflightContext): Promise<Result> {
  const root = await ctx.requireGitRoot()
  if (root === undefined)
    return result("skip", "git repository root is unavailable; node_modules integrity cannot be inspected")
  const nodeModules = join(root, "node_modules")
  if (!isDirectory(nodeModules)) return result("skip", "node_modules is absent; run the provisioning include check first")

  const packageJson = join(root, "package.json")
  let manifest: Record<string, unknown> = {}
  if (existsSync(packageJson)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(packageJson, "utf8"))
    } catch (error) {
      return result(
        "warn",
        `package.json is unreadable or invalid: ${errorMessage(error)}`,
        "repair package.json, run bun install --frozen-lockfile, then rerun the Worktrunk preflight",
      )
    }
    const object = record(parsed)
    if (object === undefined) {
      return result(
        "warn",
        "package.json is invalid: the top-level value must be an object",
        "repair package.json to contain a JSON object, run bun install --frozen-lockfile, then rerun the Worktrunk preflight",
      )
    }
    manifest = object
  }
  const declared: string[] = []
  for (const section of ["dependencies", "devDependencies"]) {
    const values = manifest[section]
    if (values === undefined || values === null) continue
    const object = record(values)
    if (object === undefined) {
      return result(
        "warn",
        `package.json is invalid: ${section} must be an object`,
        `repair package.json ${section} to be an object, run bun install --frozen-lockfile, then rerun the Worktrunk preflight`,
      )
    }
    declared.push(...Object.keys(object))
  }
  const missing = [...new Set(declared.filter((name) => !existsSync(join(nodeModules, name))))].sort()
  if (missing.length > 0) {
    let shown = missing.slice(0, 8).join(", ")
    if (missing.length > 8) shown += `, and ${missing.length - 8} more`
    return result("warn", `node_modules is partial; missing declared packages: ${shown}`, BUN_INSTALL_FIX)
  }
  const bunTypes = join(nodeModules, "@types", "bun")
  if (existsSync(bunTypes) && !isFile(join(bunTypes, "index.d.ts"))) {
    return result(
      "warn",
      "node_modules/@types/bun exists but index.d.ts is missing; this skeleton can make tsc report TS2688 while bun test passes",
      BUN_INSTALL_FIX,
    )
  }
  return result("pass", "declared node_modules packages and type packages are present")
}

export async function checkCommitGeneration(ctx: PreflightContext): Promise<Result> {
  const found = await fullConfig(ctx)
  const output = commandOutput(found)
  if (/Commit generation working/i.test(output)) {
    return result(
      "warn",
      "commit generation is configured and working; wt merge squashes into one generated commit by default, destroying per-commit history unless --no-squash is passed",
      "wt merge --no-squash",
    )
  }
  if (/\[commit\.generation\]/i.test(output)) {
    return result(
      "warn",
      "commit generation is configured; wt merge squashes into one generated commit by default, destroying per-commit history unless --no-squash is passed",
      "wt merge --no-squash",
    )
  }
  if (found.returncode === 0) return result("pass", "commit generation is not configured")
  if (unavailable(found)) return result("skip", "wt is unavailable; commit generation cannot be inspected")
  return result("skip", "wt config show did not identify commit generation status")
}

export type Check = (ctx: PreflightContext) => Promise<Result>

export const CHECKS: readonly (readonly [string, Check])[] = [
  ["wt-available", checkWtAvailable],
  ["inside-git-repo", checkInsideGitRepo],
  ["cwd-is-worktree-not-canonical", checkCwdIsWorktree],
  ["hook-approvals", checkHookApprovals],
  ["config-keys-honoured", checkConfigKeys],
  ["default-branch-resolves", checkDefaultBranch],
  ["merge-evidence-policy", checkMergeEvidence],
  ["provisioning-include", checkProvisioningInclude],
  ["provisioning-hook", checkProvisioningHook],
  ["node-modules-integrity", checkNodeModulesIntegrity],
  ["commit-generation", checkCommitGeneration],
]

export const CHECK_IDS = CHECKS.map(([id]) => id)

export function summary(results: readonly CheckReport[]): string {
  const count = (status: Status) => results.filter((item) => item.status === status).length
  const parts = [`${count("pass")} pass`, `${count("warn")} warn`, `${count("fail")} fail`]
  if (count("skip") > 0) parts.push(`${count("skip")} skip`)
  return parts.join(", ")
}

export type PreflightOptions = {
  /** Run only these checks; any non-pass then fails the report. */
  only?: readonly string[]
  /** Approve pending hooks when `hook-approvals` fails, and append missing provisioning hooks. */
  apply?: boolean
}

/** Run the checks; throws on an unknown `only` id, as the script exits on one. */
export async function runPreflight(
  options: PreflightOptions,
  ctx: PreflightContext,
  checks: readonly (readonly [string, Check])[] = CHECKS,
): Promise<Report> {
  const byId = new Map(checks)
  const selectedIds = (options.only ?? []).map((id) => id.trim()).filter(Boolean)
  const unknown = selectedIds.filter((id) => !byId.has(id))
  if (unknown.length > 0) throw new Error(`unknown check id(s): ${unknown.join(", ")}`)
  const selected = selectedIds.length > 0 ? selectedIds.map((id) => [id, byId.get(id) as Check] as const) : checks

  const results: CheckReport[] = []
  for (const [id, check] of selected) results.push({ id, ...(await check(ctx)) })

  const approval = results.findIndex((item) => item.id === "hook-approvals")
  if (options.apply && approval !== -1 && results[approval]?.status === "fail") {
    const applied = await ctx.run(["wt", "config", "approvals", "add", "--yes"])
    const refreshed = await checkHookApprovals(ctx, true)
    if (applied.returncode !== 0)
      refreshed.detail = `approval command failed: ${commandError(applied, APPROVALS_FIX)}; ${refreshed.detail}`
    results[approval] = { id: "hook-approvals", ...refreshed }
  }
  const provisioning = results.findIndex((item) => item.id === "provisioning-hook")
  if (options.apply && provisioning !== -1 && results[provisioning]?.status === "fail")
    results[provisioning] = { id: "provisioning-hook", ...(await fixProvisioningHook(ctx)) }

  const strict = selectedIds.length > 0
  const ok = !results.some((item) => item.status === "fail" || (strict && item.status !== "pass"))
  return { ok, summary: summary(results), checks: results }
}
