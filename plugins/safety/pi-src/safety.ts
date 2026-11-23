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
 * - `safety_secret_store`, registered as a tool.
 *
 * A check that asks opens `ctx.ui.confirm`; a session without dialogs (print, JSON, a subagent child) blocks the call.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  type ExtensionAPI,
  getAgentDir,
  isToolCallEventType,
  type ToolCallEventResult,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent"
import { leadingCdCwd } from "@srobroek/opencode-lib"
import { rewriteCloseKeywords } from "../shared/close-keywords.ts"
import { type ExternalDirectory, externalDirectories, sessionRoots, shellFlagDirectories } from "../shared/flag-directories.ts"
import { readProviderTypes } from "../shared/fnox-config.ts"
import { GUARD_IDS, type GuardID, type GuardOptions, hardGate } from "../shared/guards.ts"
import { decideToolCall, type MigrationOptions, migrationOverride } from "../shared/migrations.ts"
import type { ProviderTypes } from "../shared/op-guard.ts"
import { createPackageAdvisor } from "../shared/package-investigate.ts"
import { type DecisionID, type ReviewOptions, reviewPermission } from "../shared/permission.ts"
import { type PushViaConfig, readPushVia } from "../shared/push-via.ts"
import { createRedactor, type RedactOptions, type Redactor, readRedactOptions } from "../shared/redact.ts"
import {
  COMMAND_QUESTION,
  displayArgv,
  localStoreDeps,
  SECRET_STORE_DESCRIPTION,
  SECRET_STORE_INPUT,
  SecretStoreError,
  STORE_ACTION,
  type StoreDeps,
  storeResource,
  storeSecret,
  stringEnv,
} from "../shared/secret-store.ts"

export type PiFeatureID = GuardID | DecisionID | "migration-edit" | "external-directory" | "close-keywords" | "package-investigate"

/** What `disable` in the options file can turn off. */
export const PI_FEATURE_IDS: readonly PiFeatureID[] = [
  ...GUARD_IDS,
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
  pushVia: PushViaConfig | undefined
  redact: RedactOptions
}

/** The options file in pi's agent directory. */
export const OPTIONS_FILE = "safety.json"

/** `{ disable, opAllow, pushVia, redactSecrets, redactNames, redactExclude }`, read as the OpenCode options are. */
export function readPiOptions(raw: unknown): PiOptions {
  const options = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const disable: unknown[] = Array.isArray(options.disable) ? options.disable : []
  const allow: unknown[] = Array.isArray(options.opAllow) ? options.opAllow : []
  return {
    disabled: new Set(disable.filter((id): id is PiFeatureID => PI_FEATURE_IDS.includes(id as PiFeatureID))),
    opAllow: allow.filter((entry): entry is string => typeof entry === "string"),
    pushVia: readPushVia(options),
    redact: readRedactOptions(options),
  }
}

/** The options at `path`: a missing file gives the defaults, an unreadable or malformed one the defaults and a warning. */
export function loadPiOptions(path: string): { options: PiOptions; warning?: string } {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { options: readPiOptions({}) }
    return { options: readPiOptions({}), warning: `safety: ${path} could not be read; every check runs and push-via is off.` }
  }
  try {
    return { options: readPiOptions(JSON.parse(text)) }
  } catch {
    return { options: readPiOptions({}), warning: `safety: ${path} is not valid JSON; every check runs and push-via is off.` }
  }
}

export type Verdict = { kind: "run" } | { kind: "block"; reason: string } | { kind: "ask"; message: string }

const RUN: Verdict = { kind: "run" }

export type GateConfig = {
  options: PiOptions
  /** The environment the shell inherits. */
  env: NodeJS.ProcessEnv
  /** Test seams. */
  guard?: Pick<GuardOptions, "read" | "analyzeOp" | "providerTypes" | "resolveRemote">
  review?: ReviewOptions
  migrations?: MigrationOptions
}

export const REVIEW_FAILED =
  "safety (worktree-destruction-guard): the review of this command failed, so nothing it may discard was checked. Approve only if you expected this exact command."

/** The question for flag directories outside the session. */
export function externalMessage(external: readonly ExternalDirectory[]): string {
  return `safety (external-directory): this command points a tool at a directory outside the session (${external
    .map((item) => item.resource)
    .join(", ")}). Approve only if you meant to work there.`
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

/** The verdict on a `bash` command that runs in `cwd`, after any close-keyword rewrite. */
export async function gateBash(command: string, cwd: string, config: GateConfig): Promise<Verdict> {
  const { disabled } = config.options
  const gateCwd = leadingCdCwd(command, cwd)
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
      ...(config.options.pushVia ? { pushVia: config.options.pushVia } : {}),
      providerTypes,
    }),
  )
  if (refusal !== undefined) return { kind: "block", reason: refusal.reason }
  if (migrationsOn(config)) {
    const reason = await decideToolCall("bash", { command }, cwd, config.migrations).catch(() => undefined)
    if (reason) return { kind: "block", reason }
  }
  const asks: string[] = []
  try {
    const decision = await reviewPermission(command, cwd, {
      ...config.review,
      disabled: disabled as ReadonlySet<DecisionID>,
    })
    if (decision?.effect === "deny") return { kind: "block", reason: decision.message }
    if (decision?.effect === "ask") asks.push(decision.message)
  } catch {
    // pi has no permission rules to defer to, so a review that cannot finish asks.
    asks.push(REVIEW_FAILED)
  }
  if (!disabled.has("external-directory")) {
    const external = attempt(() => externalDirectories(shellFlagDirectories(command, gateCwd), sessionRoots(cwd))) ?? []
    if (external.length > 0) asks.push(externalMessage(external))
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

async function confirmStep(asker: Asker, title: string, message: string): Promise<void> {
  if (!asker.hasUI) throw new SecretStoreError(`${STORE_ACTION}: "${title}" needs the user's approval and this session cannot show a dialog; nothing was stored.`)
  if (!(await asker.ui.confirm(title, message))) throw new SecretStoreError(`${STORE_ACTION}: the user declined "${title}"; nothing was stored.`)
}

/** The store's dependencies for a pi session in `directory`: every step that needs the user confirms. */
export function piStoreDeps(
  directory: string,
  asker: Asker,
  local: Pick<StoreDeps, "env" | "home"> & Partial<Pick<StoreDeps, "run" | "which">>,
  signal?: AbortSignal,
): StoreDeps {
  return {
    ...localStoreDeps(directory, local.env, local.home ?? homedir()),
    ...local,
    ...(signal ? { signal } : {}),
    askExternal: (external) =>
      confirmStep(asker, `${STORE_ACTION}: use a fnox config outside the session?`, external.map((item) => item.resource).join("\n")),
    askStore: (request, destination) => confirmStep(asker, `${STORE_ACTION}: store this secret?`, storeResource(request, destination)),
    askCommand: (argv, cwd) => confirmStep(asker, COMMAND_QUESTION, `${displayArgv(argv)}  (in ${cwd})`),
  }
}

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"]

/** Test seams for `createSafetyExtension`; the default export passes none. */
export type Overrides = {
  optionsPath?: string
  env?: NodeJS.ProcessEnv
  guard?: GateConfig["guard"]
  review?: ReviewOptions
  migrations?: MigrationOptions
  secretStore?: Partial<Pick<StoreDeps, "run" | "which" | "env" | "home">>
}

export function createSafetyExtension(overrides: Overrides = {}) {
  return function safety(pi: ExtensionAPI): void {
    const env = overrides.env ?? process.env
    const loaded = loadPiOptions(overrides.optionsPath ?? join(getAgentDir(), OPTIONS_FILE))
    const { options } = loaded
    const on = (id: PiFeatureID) => !options.disabled.has(id)
    const config: GateConfig = {
      options,
      env,
      ...(overrides.guard ? { guard: overrides.guard } : {}),
      ...(overrides.review ? { review: overrides.review } : {}),
      ...(overrides.migrations ? { migrations: overrides.migrations } : {}),
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

    pi.registerTool({
      name: STORE_ACTION,
      label: "Store secret",
      description: SECRET_STORE_DESCRIPTION,
      parameters: SECRET_STORE_INPUT as unknown as ToolParameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const stopped = `${STORE_ACTION} stopped before it started; nothing was stored.`
        if (signal?.aborted === true) return { content: [{ type: "text", text: stopped }], details: undefined }
        const local = { env: stringEnv(env), home: homedir(), ...overrides.secretStore }
        const result = await storeSecret(params, piStoreDeps(ctx.cwd, ctx, local, signal))
        const where = "reference" in result ? `reference ${result.reference}` : `provider ${result.provider}`
        return { content: [{ type: "text", text: `Stored ${result.name} (${where}).` }], details: result }
      },
    })
  }
}

export default createSafetyExtension()
