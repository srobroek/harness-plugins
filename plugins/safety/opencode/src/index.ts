import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { Tool } from "@opencode/plugin/effect"
import { appendResultText, isShellTool, leadingCd, shellCall, WRITE_TOOLS } from "@srobroek/opencode-lib"
import { externalDirectories, sessionRoots } from "@srobroek/opencode-lib/external-directories"
import { readProviderTypes } from "@srobroek/opencode-lib/fnox-config"
import { readGitWrappers } from "@srobroek/opencode-lib/git-wrappers"
import { hostWarn, type Warn } from "@srobroek/opencode-lib/host-log"
import { rewriteCloseKeywords } from "../../shared/close-keywords.ts"
import { flagDirectoryReport } from "../../shared/flag-directories.ts"
import { GUARD_IDS, type GuardID, type GuardOptions, hardGate } from "../../shared/guards.ts"
import { decideToolCall, type MigrationOptions, migrationOverride } from "../../shared/migrations.ts"
import { createPackageAdvisor } from "../../shared/package-investigate.ts"
import { type Decision, type DecisionID, type ReviewOptions, reviewPermission } from "../../shared/permission.ts"
import { type PushViaConfig, readPushVia } from "../../shared/push-via.ts"
import { createRedactor, type RedactOptions, readRedactOptions } from "../../shared/redact.ts"
import { type AskedWatchDeps, watchAsked } from "./asked-watch.ts"
import { allowWorktreeReads, createWorktreeLister, type GitRun } from "./repo-worktrees.ts"
import { allowScratch, realRoots, scratchRoots } from "./scratch-dirs.ts"
import { allowSkillReads, listedSkills, READ_ONLY_TOOLS, skillDirectories } from "./skill-references.ts"
import { allowSteeringReads, readSteeringDirs, steeringRoots } from "./steering-dirs.ts"
import { denyUnanswerable, type SessionInfo, unanswerableDenial } from "./subagent-prompts.ts"
import { allowRootReads, allowSubagentReads } from "./subagent-reads.ts"

export { externalDirectories } from "@srobroek/opencode-lib/external-directories"
export { normalize as normalizeCloseKeywords, rewriteCloseKeywords } from "../../shared/close-keywords.ts"
export { flagDirectories, flagDirectoryReport, shellFlagDirectories } from "../../shared/flag-directories.ts"
export { hardGate, MESSAGES } from "../../shared/guards.ts"
export { decidePath as decideMigrationPath, latestMigration, migrationTarget } from "../../shared/migrations.ts"
export { INVESTIGATE_NOTICE, packagesToInvestigate } from "../../shared/package-investigate.ts"
export { reviewPermission } from "../../shared/permission.ts"
export {
  collectSecrets,
  createRedactor,
  looksSecret,
  orderSecrets,
  readRedactOptions,
  redactText,
  redactValue,
} from "../../shared/redact.ts"
export { allowSkillReads, skillDirectories } from "./skill-references.ts"
export { denyUnanswerable, unanswerableMessage } from "./subagent-prompts.ts"
export { allowRootReads, allowSubagentReads, isSecretResource, SECRET_LOCATIONS } from "./subagent-reads.ts"

export type FeatureID =
  | GuardID
  | DecisionID
  | "close-keywords"
  | "package-investigate"
  | "migration-edit"
  | "external-directory"
  | "skill-references"
  | "steering-dirs"
  | "scratch-shell"
  | "repo-worktrees"
  | "subagent-external-reads"
  | "root-external-reads"
  | "subagent-prompts"

export const FEATURE_IDS: readonly FeatureID[] = [
  ...GUARD_IDS,
  "force-push",
  "sudo-destructive",
  "worktree-destruction",
  "close-keywords",
  "package-investigate",
  "migration-edit",
  "external-directory",
  "skill-references",
  "steering-dirs",
  "scratch-shell",
  "repo-worktrees",
  "subagent-external-reads",
  "root-external-reads",
  "subagent-prompts",
]

export type SafetyOptions = {
  disabled: ReadonlySet<FeatureID>
  redact: RedactOptions
  opAllow: string[]
  scratchDirs: boolean
  steeringDirs: string[]
  /** Extra secret locations the `subagent-external-reads` check never allows. */
  secretPaths: string[]
  /** Host whose plain `git push` is refused in favour of a wrapper command; off when absent. */
  pushVia: PushViaConfig | undefined
  /** Command names the gates read as git; only `git` by default. */
  gitWrappers: readonly string[]
}

/**
 * `{ disable: ["worktree-tmp", …] }` turns features off; unknown ids are ignored.
 * `opAllow` lists extra `op` subcommand prefixes the op-guard allows.
 * `scratchDirs: false` stops allowing the OpenCode temp folder, the project's worktree, shell-output and tool-output folders, and the session's own directory.
 * `steeringDirs` lists the directories whose files the read-only tools may read without a prompt (default
 * `["~/.config/opencode/steering"]`; a list replaces the default); `disable: ["steering-dirs"]` stops it.
 * `disable: ["scratch-shell"]` stops allowing shell calls whose directories are all scratch folders, and
 * `disable: ["repo-worktrees"]` stops allowing reads in the session repository's other worktrees.
 * `disable: ["skill-references"]` stops allowing reads in installed skills' directories.
 * `disable: ["subagent-external-reads"]` stops allowing a subagent's read-only and shell `external_directory` asks;
 * `disable: ["root-external-reads"]` stops allowing a root session's `read` of one non-secret file outside the directory;
 * `subagentSecretPaths` adds locations (`~/…` or absolute) to `SECRET_LOCATIONS` that stay asks in both.
 * `disable: ["subagent-prompts"]` lets a subagent session's asks prompt instead of failing at once.
 * `pushVia: { host, command }` refuses a plain `git push` whose remote resolves to `host` and names `command -C <dir> push`; off by default.
 * `redactSecrets`, `redactNames` and `redactExclude` configure secret redaction.
 * `gitWrappers` lists the command names the gates read as git, matched on the basename (default `["git"]`).
 */
export function readOptions(options: Readonly<Record<string, unknown>> | undefined): SafetyOptions {
  const raw = options?.disable
  const list = Array.isArray(raw) ? raw.filter((id): id is FeatureID => FEATURE_IDS.includes(id as FeatureID)) : []
  const allow = options?.opAllow
  const opAllow = Array.isArray(allow) ? allow.filter((entry): entry is string => typeof entry === "string") : []
  const paths = options?.subagentSecretPaths
  const secretPaths = Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === "string") : []
  return {
    disabled: new Set(list),
    redact: readRedactOptions(options),
    opAllow,
    scratchDirs: options?.scratchDirs !== false,
    steeringDirs: readSteeringDirs(options?.steeringDirs),
    secretPaths,
    pushVia: readPushVia(options),
    gitWrappers: readGitWrappers(options),
  }
}

/** The directory a shell call runs in: its `workdir`, resolved against the session's directory. */
export function shellCwd(workdir: string | undefined, sessionDirectory: string): string {
  if (workdir === undefined) return sessionDirectory
  return isAbsolute(workdir) ? workdir : resolve(sessionDirectory, workdir)
}

/** The evaluation fields the gate reads and writes. */
export type Evaluation = {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly source?: { readonly type: string; readonly id?: string }
  effect: "allow" | "deny" | "ask"
  message?: string
}

/** Apply a decision to an evaluation without ever loosening it. */
export function applyDecision(evaluation: Evaluation, decision: Decision | undefined): void {
  if (decision === undefined || evaluation.effect === "deny") return
  if (decision.effect === "deny") {
    evaluation.effect = "deny"
    evaluation.message = decision.message
    return
  }
  evaluation.effect = "ask"
  evaluation.message = evaluation.message ? `${evaluation.message}\n\n${decision.message}` : decision.message
}

/** A hard gate that fails internally lets the call through: a parser bug must not take the shell down. */
function safely<T>(run: () => T): T | undefined {
  try {
    return run()
  } catch {
    return undefined
  }
}

/**
 * The refusal for relative flag directories after a leading `cd` this plugin cannot read. OpenCode's
 * `external_directory` question needs an absolute resource to show and save, which such a flag lacks.
 */
export function unresolvedFlagRefusal(unresolved: readonly string[]): string {
  return `Blocked by safety (external-directory): this command starts with a cd this guard cannot read (a quoted, expanded, \`..\` or redirected directory), so it cannot tell where ${unresolved
    .map((value) => `\`${value}\``)
    .join(", ")} points. Give the flag an absolute path, use the shell tool's workdir, or start with \`cd <literal path> &&\`.`
}

/**
 * A permission review that fails internally (an unexpected exception such as a parser bug; handled probe timeouts still ask) makes no
 * decision and logs the error. `undefined` means "defer to the host's permission rules", never "allow": the
 * caller leaves the evaluation's effect as the host set it, so a configured deny or ask still applies.
 */
export async function review(
  command: string,
  cwd: string,
  options: ReviewOptions,
  warn: Warn = () => {},
): Promise<Decision | undefined> {
  try {
    return await reviewPermission(command, cwd, options)
  } catch (error) {
    warn("permission review failed; safety's extra review is skipped for this command", {
      error: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/** Tools that open the path they were given themselves, with no shell between the check and the use. */
export const DIRECT_FILE_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "patch", "apply_patch", "glob", "grep", "list"])

const PENDING_TTL_MS = 10 * 60_000

type Pending = { sessionID: string; at: number; decision: Decision | undefined }

/** The `permission.asked` payload fields the backstop reads. */
type AskedRequest = {
  readonly id?: string
  readonly sessionID?: string
  readonly action?: string
  readonly resources?: ReadonlyArray<string>
  readonly message?: string
}

/** Test seams; the host never passes these. */
export type Overrides = {
  review?: ReviewOptions
  migrations?: MigrationOptions
  env?: NodeJS.ProcessEnv
  guard?: Pick<GuardOptions, "read" | "analyzeOp" | "providerTypes">
  scratch?: { roots?: readonly string[] }
  steering?: { home?: string }
  worktrees?: { run?: GitRun; ttlMs?: number }
  warn?: Warn
  /** Backoff clock of the prompt watch. */
  watch?: Pick<AskedWatchDeps, "delaysMs" | "sleep">
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.safety",
    async setup(ctx) {
      // Bound before the first await, while the fiber still carries the host's logger.
      const warn = overrides.warn ?? hostWarn("srobroek.safety")
      const { disabled, redact, opAllow, scratchDirs, steeringDirs, secretPaths, pushVia, gitWrappers } = readOptions(ctx.options)
      const on = (id: FeatureID) => !disabled.has(id)
      const guardOptions = {
        env: overrides.env ?? process.env,
        ...overrides.guard,
        disabled: disabled as ReadonlySet<GuardID>,
        opAllow,
        pushVia,
        gitWrappers,
      }
      const reviewOptions: ReviewOptions = { ...overrides.review, disabled: disabled as ReadonlySet<DecisionID>, gitWrappers }
      const pending = new Map<string, Pending>()
      const advisor = createPackageAdvisor()

      const sessionDirectory = (sessionID: string): Promise<string> =>
        ctx.session
          .get({ sessionID } as never)
          .then((session) => (session as { location: { directory: string } }).location.directory)
          .catch(() => ctx.location.directory as string)

      // For an allow decision: the session's own directory, or `undefined` (logged) when it cannot be read.
      const strictSessionDirectory = (sessionID: string): Promise<string | undefined> =>
        ctx.session
          .get({ sessionID } as never)
          .then((session) => (session as { location?: { directory?: string } }).location?.directory)
          .catch((error: unknown) => {
            warn("session lookup failed; the worktree allow is skipped", {
              sessionID,
              error: error instanceof Error ? error.name : typeof error,
            })
            return undefined
          })

      // The tool behind each running call, so a permission request can be traced to it.
      const running = new Map<string, { tool: string; input: unknown; at: number }>()

      const prune = () => {
        const cutoff = Date.now() - PENDING_TTL_MS
        for (const [id, entry] of pending) if (entry.at < cutoff) pending.delete(id)
        for (const [id, entry] of running) if (entry.at < cutoff) running.delete(id)
      }

      const before = await ctx.tool.hook("execute.before", async (event) => {
        running.set(event.id, { tool: event.tool, input: event.input, at: Date.now() })
        const call = shellCall(event.tool, event.input)
        if (call === undefined || call.command.trim() === "") return
        let command = call.command
        if (on("close-keywords")) {
          const rewritten = rewriteCloseKeywords(command)
          if (rewritten !== undefined) {
            command = rewritten
            event.input = { ...(event.input as object), command }
          }
        }
        const cwd = shellCwd(call.workdir, await sessionDirectory(event.sessionID))
        const lead = leadingCd(command, cwd)
        const gateCwd = lead.kind === "dir" ? lead.dir : cwd
        // The fnox config is read from the call's own directory, and only when the guard asks for a type;
        // the guard ignores it when the command changes directory.
        let types: ReturnType<typeof readProviderTypes> | undefined
        const providerTypes =
          guardOptions.providerTypes ??
          ((name: string, config?: string) => {
            types ??= readProviderTypes(cwd)
            return types(name, config)
          })
        const refusal = safely(() => hardGate(command, gateCwd, { ...guardOptions, providerTypes }))
        if (refusal !== undefined) throw new Error(refusal.reason)
        if (on("external-directory")) {
          const sessionDir = await sessionDirectory(event.sessionID)
          // After a leading cd this plugin cannot read, a relative flag directory has no known base.
          const flags = safely(() => flagDirectoryReport(command, lead.kind === "rejected" ? undefined : gateCwd, gitWrappers))
          if (flags !== undefined && flags.unresolved.length > 0) throw new Error(unresolvedFlagRefusal(flags.unresolved))
          const external = flags === undefined ? [] : (safely(() => externalDirectories(flags.dirs, sessionRoots(sessionDir))) ?? [])
          if (external.length > 0)
            await ctx.permission.assert({
              sessionID: event.sessionID,
              agent: event.agent,
              source: { type: "tool", messageID: event.messageID, id: event.id },
              action: "external_directory",
              resources: external.map((item) => item.resource),
              save: external.map((item) => item.save),
            } as never)
        }
        prune()
        const decision = await review(command, cwd, reviewOptions, warn)
        pending.set(event.id, { sessionID: event.sessionID, at: Date.now(), decision })
      })

      const migrations = await ctx.tool.hook("execute.before", async (event) => {
        if (!on("migration-edit") || migrationOverride(overrides.env)) return
        if (!WRITE_TOOLS.has(event.tool) && !isShellTool(event.tool)) return
        const call = shellCall(event.tool, event.input)
        const directory = await sessionDirectory(event.sessionID)
        const cwd = call === undefined ? directory : shellCwd(call.workdir, directory)
        const input = call === undefined ? event.input : { command: call.command }
        const reason = await decideToolCall(event.tool, input, cwd, overrides.migrations).catch(() => undefined)
        if (reason) throw new Error(reason)
      })

      const gate = await ctx.permission.hook("evaluate", async (evaluation) => {
        if (evaluation.action !== "shell" || evaluation.effect === "deny") return
        const id = evaluation.source?.type === "tool" ? evaluation.source.id : undefined
        const entry = id === undefined ? undefined : pending.get(id)
        const decision =
          entry !== undefined
            ? entry.decision
            : await review(
                evaluation.resources.join("\n"),
                await sessionDirectory(evaluation.sessionID),
                reviewOptions,
                warn,
              )
        applyDecision(evaluation as Evaluation, decision)
      })

      const scratch = scratchDirs
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
            // A shell command can swap a scratch folder for a symlink between this check and its use, so only
            // direct file tools qualify; an unknown source stays an ask.
            const source = evaluation.source
            const tool = source?.type === "tool" ? running.get(source.id)?.tool : undefined
            // A shell call qualifies only because every resource must lie in a pinned root; a flag directory
            // (`git -C`, `--prefix`) outside the roots keeps the ask.
            if (tool === undefined || !(DIRECT_FILE_TOOLS.has(tool) || (on("scratch-shell") && isShellTool(tool)))) return
            const roots =
              overrides.scratch?.roots ??
              (await ctx.session
                .get({ sessionID: evaluation.sessionID } as never)
                .then((session) => scratchRoots((session as { projectID: string }).projectID))
                .catch(() => []))
            allowScratch(evaluation, [...roots, ...realRoots(sessionRoots(await sessionDirectory(evaluation.sessionID)))])
          })
        : undefined

      const skillReads = on("skill-references")
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
            const source = evaluation.source
            const tool = source?.type === "tool" ? running.get(source.id)?.tool : undefined
            if (tool === undefined || !READ_ONLY_TOOLS.has(tool)) return
            const directory = await sessionDirectory(evaluation.sessionID)
            // A host error is not "no skills installed": the prompt stays (nothing is auto-allowed) and the failure is logged.
            const listed = await ctx.skill.list({ location: { directory } } as never).catch((error: unknown) => {
              warn("skill lookup failed; the permission prompt stays", {
                sessionID: evaluation.sessionID,
                error: error instanceof Error ? error.name : typeof error,
              })
              return undefined
            })
            allowSkillReads(evaluation, skillDirectories(listedSkills(listed)))
          })
        : undefined

      const steering = on("steering-dirs")
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
            const source = evaluation.source
            const tool = source?.type === "tool" ? running.get(source.id)?.tool : undefined
            if (tool === undefined || !READ_ONLY_TOOLS.has(tool)) return
            allowSteeringReads(evaluation, steeringRoots(steeringDirs, overrides.steering?.home))
          })
        : undefined

      const worktreeRoots = createWorktreeLister(overrides.worktrees)
      const repoWorktrees = on("repo-worktrees")
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
            const source = evaluation.source
            const tool = source?.type === "tool" ? running.get(source.id)?.tool : undefined
            if (tool === undefined || !READ_ONLY_TOOLS.has(tool)) return
            // Fails closed: without the requesting session's own directory there is no repository to match,
            // so the ask stays (the plugin's location is never a stand-in for an allow).
            const directory = await strictSessionDirectory(evaluation.sessionID)
            if (directory === undefined) return
            allowWorktreeReads(evaluation, await worktreeRoots(directory))
          })
        : undefined

      const after = await ctx.tool.hook("execute.after", (event) => {
        pending.delete(event.id)
        running.delete(event.id)
        if (!on("package-investigate") || event.status !== "completed") return
        const call = shellCall(event.tool, event.input)
        if (call === undefined) return
        const notice = advisor.notice(event.sessionID, call.command)
        if (notice !== undefined) event.result = appendResultText(event.result, notice)
      })

      // Registered after this plugin's other evaluate hooks, so it sees the asks they leave or add.
      const sessionInfo = (sessionID: string): Promise<SessionInfo | undefined> =>
        ctx.session
          .get({ sessionID } as never)
          .then((info) => info as SessionInfo)
          .catch((error: unknown) => {
            // The error's name only: a host message could carry a path.
            warn("session lookup failed; the permission prompt stays", {
              sessionID,
              error: error instanceof Error ? error.name : typeof error,
            })
            return undefined
          })
      // Before `subagent-prompts`, so the asks it allows never reach the deny.
      const subagentReadsOn = on("subagent-external-reads")
      const rootReadsOn = on("root-external-reads")
      const subagentReads = subagentReadsOn || rootReadsOn
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
            const source = evaluation.source
            const call = source?.type === "tool" ? running.get(source.id) : undefined
            const tool = call?.tool
            if (tool === undefined) return
            // A failed lookup stays an ask; `subagent-prompts` logs it, so this hook stays quiet.
            const info = (await ctx.session.get({ sessionID: evaluation.sessionID } as never).catch(() => undefined)) as SessionInfo | undefined
            if (info === undefined) return
            const isSubagent = typeof info.parentID === "string" && info.parentID !== ""
            if (subagentReadsOn) allowSubagentReads(evaluation, tool, isSubagent, secretPaths)
            // The read tool's own argument: `path` on current hosts, `filePath` on older ones.
            const input = call?.input as { path?: unknown; filePath?: unknown } | undefined
            const filePath = input?.path ?? input?.filePath
            if (rootReadsOn) allowRootReads(evaluation, tool, filePath, isSubagent, secretPaths)
          })
        : undefined
      const unanswerable = on("subagent-prompts")
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.effect !== "ask") return
            denyUnanswerable(evaluation, await sessionInfo(evaluation.sessionID))
          })
        : undefined

      // A plugin whose evaluate hook runs after this one can still raise a prompt in a subagent session,
      // so every prompt the host raises in this location is checked again and rejected through the reply API.
      // The evaluate hook above already denies a child's prompt; this watch is the second layer, and it is
      // reactive: a user's answer can land first. Then the reply below is a no-op or a rejected call that
      // is warned about, and the user's decision stands, so the race is benign.
      const watching = new AbortController()
      const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error)
      const watch = on("subagent-prompts")
        ? watchAsked({
            subscribe: () => ctx.event.subscribe({ types: ["permission.asked"], signal: watching.signal } as never)[Symbol.asyncIterator](),
            handle: async (event) => {
              const { type, data } = event as { type?: string; data?: AskedRequest }
              if (type !== "permission.asked" || data === undefined) return
              await rejectUnanswerable(data).catch((error: unknown) =>
                warn("could not reject a subagent's permission prompt", { sessionID: data.sessionID, error: errorName(error) }),
              )
            },
            // An abort is the teardown and never reaches here; anything else is a host failure.
            onFailure: ({ error, attempt, willRetry }) =>
              warn(
                willRetry
                  ? `permission prompt watch failed; resubscribing (attempt ${attempt})`
                  : "permission prompt watch stopped; prompts a later plugin raises in subagent sessions are no longer rejected",
                { error },
              ),
            signal: watching.signal,
            ...overrides.watch,
          })
        : undefined
      async function rejectUnanswerable(request: AskedRequest): Promise<void> {
        if (typeof request.sessionID !== "string" || typeof request.id !== "string") return
        const message = unanswerableDenial(
          { action: request.action ?? "permission", resources: request.resources ?? [], message: request.message },
          await sessionInfo(request.sessionID),
        )
        // The lookup can outlive the plugin; a reply after teardown would act on a stopped backstop.
        if (message === undefined || watching.signal.aborted) return
        await ctx.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: "reject", message } as never)
      }

      // Registered last so it also sees the notices the hooks above append.
      const redactor = redact.enabled ? createRedactor(() => overrides.env ?? process.env, redact) : undefined
      const redacting = redactor
        ? [
            await ctx.shell.hook("create.before", (event) => redactor.absorb(event.env)),
            await ctx.tool.hook("execute.after", (event) => {
              redactor.refresh()
              if (redactor.secrets().length === 0) return
              if (event.status === "completed") {
                event.result = redactor.value(event.result)
                return
              }
              const { message, error, metadata } = event.error
              const clean = { message: redactor.text(message), error: redactor.value(error), metadata: redactor.value(metadata) }
              if (clean.message === message && clean.error === error && clean.metadata === metadata) return
              // Build the replacement from the event's own class: the host's `@opencode/plugin/effect` does not export
              // `Tool` before 2.3, and a value import of it makes the whole plugin fail to load there.
              const ToolError = event.error.constructor as typeof Tool.Error
              event.error = new ToolError({
                message: clean.message,
                ...(clean.error === undefined ? {} : { error: clean.error }),
                ...(clean.metadata === undefined ? {} : { metadata: clean.metadata }),
              })
            }),
          ]
        : []

      return async () => {
        for (const registration of redacting.reverse()) await registration.dispose()
        await unanswerable?.dispose()
        await subagentReads?.dispose()
        watching.abort()
        // Ending the iterator ends the loop above; it is not awaited, since a pending read may never settle.
        watch?.stop()
        await after.dispose()
        await repoWorktrees?.dispose()
        await steering?.dispose()
        await skillReads?.dispose()
        await scratch?.dispose()
        await gate.dispose()
        await migrations.dispose()
        await before.dispose()
        pending.clear()
      }
    },
  })
}

export default createPlugin()
