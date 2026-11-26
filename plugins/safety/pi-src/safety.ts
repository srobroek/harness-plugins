/**
 * The safety plugin on pi, from the modules the OpenCode adapter runs. It loads after `cc-safety-net`,
 * which blocks generic destructive commands and secret paths. Every OpenCode guard still runs here:
 * where both block a call the first block wins, and cc-safety-net misses cases in each guard's corpus.
 *
 * - `tool_call` on `bash`: the close-keyword rewrite (mutating `event.input.command`), the hard gates,
 *   shipped-migration writes, the force-push refusal, and the asks for destructive `sudo`, branch
 *   deletes, worktree removals, reset/stash/reflog/clean and flag directories outside the session.
 * - `tool_call` on `edit`/`write`: shipped-migration writes.
 * - `tool_result`: the package-vetting advisory, then secret redaction of every result.
 *
 * The `safety_secret_store` tool ships in the secret-store plugin.
 *
 * A check that asks opens `ctx.ui.confirm`; a session without dialogs (print, JSON, a subagent child) blocks the call.
 */

import { join } from "node:path"
import {
  type ExtensionAPI,
  getAgentDir,
  isToolCallEventType,
  type ToolCallEventResult,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent"
import { leadingCd } from "@srobroek/opencode-lib"
import type { ExternalDirectory } from "@srobroek/opencode-lib/external-directories"
import { type ProviderTypes, readProviderTypes } from "@srobroek/opencode-lib/fnox-config"
import { readGitWrappers } from "@srobroek/opencode-lib/git-wrappers"
import { loadPiPluginSettings, PI_SETTINGS_FILE } from "@srobroek/opencode-lib/pi-settings"
import { rewriteCloseKeywords } from "../shared/close-keywords.ts"
import { callFlagDirectoryReport, externalFlagDirectories } from "../shared/flag-directories.ts"
import { GUARD_IDS, type GuardID, type GuardOptions, hardGate } from "../shared/guards.ts"
import { decideToolCall, type MigrationOptions, migrationOverride } from "../shared/migrations.ts"
import { createPackageAdvisor } from "../shared/package-investigate.ts"
import { type DecisionID, type ReviewOptions, reviewPermission } from "../shared/permission.ts"
import { createRedactor, type RedactOptions, type Redactor, readRedactOptions } from "../shared/redact.ts"
import { SYSTEM_GATE_IDS, type SystemGateID, type SystemGateOptions, systemGate } from "./system-gates.ts"

export type PiFeatureID =
  | GuardID
  | SystemGateID
  | DecisionID
  | "migration-edit"
  | "external-directory"
  | "close-keywords"
  | "package-investigate"

/** What `disable` under the `safety` settings key can turn off. */
export const PI_FEATURE_IDS: readonly PiFeatureID[] = [
  ...GUARD_IDS,
  ...SYSTEM_GATE_IDS,
  "force-push",
  "sudo-destructive",
  "worktree-destruction",
  "migration-edit",
  "external-directory",
  "close-keywords",
  "package-investigate",
]

export type PiOptions = {
  disabled: ReadonlySet<PiFeatureID>
  opAllow: readonly string[]
  redact: RedactOptions
  /** Command names the gates read as git; only `git` by default. */
  gitWrappers: readonly string[]
}

/** `{ disable, opAllow, gitWrappers, redactSecrets, redactNames, redactExclude }`, read as the OpenCode options are. */
export function readPiOptions(raw: unknown): PiOptions {
  const options = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const disable: unknown[] = Array.isArray(options.disable) ? options.disable : []
  const allow: unknown[] = Array.isArray(options.opAllow) ? options.opAllow : []
  return {
    disabled: new Set(disable.filter((id): id is PiFeatureID => PI_FEATURE_IDS.includes(id as PiFeatureID))),
    opAllow: allow.filter((entry): entry is string => typeof entry === "string"),
    redact: readRedactOptions(options),
    gitWrappers: readGitWrappers(options),
  }
}

/**
 * The options under the `safety` key of the settings file at `path`: a missing file or key gives the
 * defaults, an unreadable or malformed file or a key that is not an object the defaults and a warning.
 */
export function loadPiOptions(path: string): { options: PiOptions; warning?: string } {
  const loaded = loadPiPluginSettings(path, "safety", "every check runs")
  const options = readPiOptions(loaded.options)
  return loaded.warning === undefined ? { options } : { options, warning: loaded.warning }
}

export type Verdict = { kind: "run" } | { kind: "block"; reason: string } | { kind: "ask"; message: string }

const RUN: Verdict = { kind: "run" }

export type GateConfig = {
  options: PiOptions
  /** The environment the shell inherits. */
  env: NodeJS.ProcessEnv
  /** Test seams. */
  guard?: Pick<GuardOptions, "read" | "analyzeOp" | "providerTypes">
  review?: ReviewOptions
  migrations?: MigrationOptions
  system?: Pick<SystemGateOptions, "home" | "tempRoots" | "managed">
}

export const REVIEW_FAILED =
  "safety (worktree-destruction-guard): the review of this command failed, so nothing it may discard was checked. Approve only if you expected this exact command."

/** The question for flag directories outside the session. */
export function externalMessage(external: readonly ExternalDirectory[]): string {
  return `safety (external-directory): this command points a tool at a directory outside the session (${external
    .map((item) => item.resource)
    .join(", ")}). Approve only if you meant to work there.`
}

/** The question for relative flag directories after a leading `cd` whose directory cannot be read. */
export function unresolvedMessage(unresolved: readonly string[]): string {
  return `safety (external-directory): this command starts with a cd this guard cannot read (a quoted, expanded, \`..\` or redirected directory), so it cannot tell where ${unresolved
    .map((value) => `\`${value}\``)
    .join(", ")} points. Approve only if you meant to work there.`
}

/** A check that fails internally lets the call through, as on OpenCode: a parser bug must not take the shell down. */
function attempt<T>(run: () => T): T | undefined {
  try {
    return run()
  } catch {
    return undefined
  }
}

function migrationsOn(config: GateConfig): boolean {
  return !config.options.disabled.has("migration-edit") && !migrationOverride(config.env)
}

/**
 * The verdict on a `bash` command that runs in `cwd`, after any close-keyword rewrite. A leading `cd`
 * to a literal directory moves the gates there. One whose directory cannot be read leaves them in
 * `cwd`: the checks that follow `cd` themselves see it (history rewrites, write targets, the op-guard,
 * branch deletes, worktree removals). The flag-directory check reads the leading `cd` its own way
 * (`callFlagDirectoryReport`), and takes the session repository's worktrees as inside.
 */
export async function gateBash(command: string, cwd: string, config: GateConfig): Promise<Verdict> {
  const { disabled } = config.options
  const lead = leadingCd(command, cwd)
  const gateCwd = lead.kind === "dir" ? lead.dir : cwd
  // The fnox config is read from the call's own directory, and only when the op-guard asks for a type.
  let types: ProviderTypes | undefined
  const providerTypes: ProviderTypes =
    config.guard?.providerTypes ??
    ((name, file) => {
      types ??= readProviderTypes(cwd)
      return types(name, file)
    })
  const refusal = attempt(() =>
    hardGate(command, gateCwd, {
      env: config.env,
      ...config.guard,
      // The checks only call `has`, as in the OpenCode adapter, so a non-guard id is harmless here.
      disabled: disabled as ReadonlySet<GuardID>,
      opAllow: config.options.opAllow,
      gitWrappers: config.options.gitWrappers,
      providerTypes,
    }),
  )
  if (refusal !== undefined) return { kind: "block", reason: refusal.reason }
  const system = await systemGate(command, gateCwd, { ...config.system, disabled }).catch(() => undefined)
  if (system !== undefined) return { kind: "block", reason: system.reason }
  if (migrationsOn(config)) {
    const reason = await decideToolCall("bash", { command }, cwd, config.migrations).catch(() => undefined)
    if (reason) return { kind: "block", reason }
  }
  const asks: string[] = []
  try {
    const decision = await reviewPermission(command, cwd, {
      ...config.review,
      disabled: disabled as ReadonlySet<DecisionID>,
      gitWrappers: config.options.gitWrappers,
    })
    if (decision?.effect === "deny") return { kind: "block", reason: decision.message }
    if (decision?.effect === "ask") asks.push(decision.message)
  } catch {
    // pi has no permission rules to defer to, so a review that cannot finish asks.
    asks.push(REVIEW_FAILED)
  }
  if (!disabled.has("external-directory")) {
    const flags = attempt(() => callFlagDirectoryReport(command, cwd, config.options.gitWrappers))
    const external = flags === undefined ? [] : (attempt(() => externalFlagDirectories(flags.dirs, cwd)) ?? [])
    if (external.length > 0) asks.push(externalMessage(external))
    if (flags !== undefined && flags.unresolved.length > 0) asks.push(unresolvedMessage(flags.unresolved))
  }
  return asks.length === 0 ? RUN : { kind: "ask", message: asks.join("\n\n") }
}

/** The verdict on an `edit` or `write` call: only a shipped migration is refused. */
export async function gateWrite(tool: string, input: unknown, cwd: string, config: GateConfig): Promise<Verdict> {
  if (!migrationsOn(config)) return RUN
  const reason = await decideToolCall(tool, input, cwd, config.migrations).catch(() => undefined)
  return reason ? { kind: "block", reason } : RUN
}

/** The part of the extension context a confirmation needs. */
export type Asker = { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }

export const NO_UI_REFUSAL =
  "Blocked by safety: this call needs the user's approval, and this pi session cannot show a dialog (print or JSON mode, or a subagent child). Hand the command to the user, or run it from an interactive session."

export const DECLINED = "Blocked by safety: the user declined this call."

/** The `tool_call` result for a verdict: a question is confirmed, and blocks without a dialog. */
export async function settle(verdict: Verdict, asker: Asker): Promise<ToolCallEventResult | undefined> {
  if (verdict.kind === "run") return undefined
  if (verdict.kind === "block") return { block: true, reason: verdict.reason }
  if (!asker.hasUI) return { block: true, reason: `${NO_UI_REFUSAL}\n\n${verdict.message}` }
  if (await asker.ui.confirm("safety: approve this command?", verdict.message)) return undefined
  return { block: true, reason: `${DECLINED}\n\n${verdict.message}` }
}

/**
 * The `tool_result` patch: `notice` appended, then every secret value replaced in the content, the
 * details and the structured content. `undefined` when nothing changes.
 */
export function resultPatch(
  event: Pick<ToolResultEvent, "content" | "details" | "structuredContent">,
  notice: string | undefined,
  redactor: Redactor | undefined,
): ToolResultEventResult | undefined {
  const appended = notice === undefined ? event.content : [...event.content, { type: "text" as const, text: notice }]
  const content = redactor ? redactor.value(appended) : appended
  const details = redactor ? redactor.value(event.details) : event.details
  const structuredContent = redactor ? redactor.value(event.structuredContent) : event.structuredContent
  const patch: ToolResultEventResult = {}
  if (content !== event.content) patch.content = content
  if (details !== event.details) patch.details = details
  // pi drops structured content that a new `content` patch does not return with it.
  if (structuredContent !== undefined && (patch.content !== undefined || structuredContent !== event.structuredContent))
    patch.structuredContent = structuredContent
  return Object.keys(patch).length === 0 ? undefined : patch
}

/** Test seams for `createSafetyExtension`; the default export passes none. */
export type Overrides = {
  /** Replaces `<agentDir>/settings.json`. */
  settingsPath?: string
  env?: NodeJS.ProcessEnv
  guard?: GateConfig["guard"]
  review?: ReviewOptions
  migrations?: MigrationOptions
  system?: GateConfig["system"]
}

export function createSafetyExtension(overrides: Overrides = {}) {
  return function safety(pi: ExtensionAPI): void {
    const env = overrides.env ?? process.env
    const loaded = loadPiOptions(overrides.settingsPath ?? join(getAgentDir(), PI_SETTINGS_FILE))
    const { options } = loaded
    const on = (id: PiFeatureID) => !options.disabled.has(id)
    const config: GateConfig = {
      options,
      env,
      ...(overrides.guard ? { guard: overrides.guard } : {}),
      ...(overrides.review ? { review: overrides.review } : {}),
      ...(overrides.migrations ? { migrations: overrides.migrations } : {}),
      ...(overrides.system ? { system: overrides.system } : {}),
    }
    const advisor = createPackageAdvisor()
    const redactor = options.redact.enabled ? createRedactor(() => env, options.redact) : undefined
    const warning = loaded.warning

    if (warning !== undefined)
      pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.notify(warning, "warning")
      })

    pi.on("tool_call", async (event, ctx) => {
      if (isToolCallEventType("bash", event)) {
        if (event.input.command.trim() === "") return undefined
        if (on("close-keywords")) {
          const rewritten = rewriteCloseKeywords(event.input.command)
          if (rewritten !== undefined) event.input.command = rewritten
        }
        return settle(await gateBash(event.input.command, ctx.cwd, config), ctx)
      }
      if (isToolCallEventType("edit", event) || isToolCallEventType("write", event))
        return settle(await gateWrite(event.toolName, event.input, ctx.cwd, config), ctx)
      return undefined
    })

    pi.on("tool_result", (event, ctx) => {
      redactor?.refresh()
      const command = event.toolName === "bash" ? event.input.command : undefined
      const notice =
        on("package-investigate") && !event.isError && typeof command === "string"
          ? advisor.notice(ctx.sessionManager.getSessionId(), command)
          : undefined
      return resultPatch(event, notice, redactor)
    })
  }
}

export default createSafetyExtension()
