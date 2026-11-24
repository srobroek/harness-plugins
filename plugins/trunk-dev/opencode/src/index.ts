import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { appendResultText, shellCall, shellExit } from "@srobroek/opencode-lib";
import { DEFAULT_GIT_WRAPPERS, readGitWrappers } from "@srobroek/opencode-lib/git-wrappers";
import { registerSkills } from "@srobroek/opencode-lib/skill-files";
import { decideCommitGate } from "../../shared/commit-gate.js";
import { flagCleanupFollowUp, landedMerge, type MergeRequest, shellMerges } from "../../shared/flag-cleanup.js";
import { decideMrAdvisory } from "../../shared/mr-advisory.js";
import { skipCiAdvisory } from "../../shared/skip-ci.js";
import { sessionReminder } from "./session-reminders.ts";

export { COMMIT_OVERRIDE, conventional, decideCommitGate, MESSAGES, PUSH_OVERRIDE } from "../../shared/commit-gate.js";
export {
    createCleanup,
    decideFlagCleanup,
    flagCleanupFollowUp,
    landedMerge,
    mergedForgeData,
    shellMerges
} from "../../shared/flag-cleanup.js";
export { ADVICE, decideMrAdvisory } from "../../shared/mr-advisory.js";
export { SKIP_CI_ADVISORY, skipCiAdvisory } from "../../shared/skip-ci.js";

export const LAND_TOOL = "delivery_land"

export const SKILL_NAMES = ["trunk-dev-workflow", "trunk-dev-feature-flags", "trunk-dev-release-setup", "trunk-dev-guide"] as const

export const SKILL_PATHS = SKILL_NAMES.map((name) =>
  fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
)

export const FEATURE_IDS = ["commit-gate", "skip-ci", "mr-advisory", "mr-title", "flag-cleanup", "session-reminders"] as const
export type FeatureID = (typeof FEATURE_IDS)[number]

/** `{ disable: ["commit-gate", …] }` turns features off; unknown ids are ignored. */
export function readOptions(options: Readonly<Record<string, unknown>> | undefined): ReadonlySet<FeatureID> {
  const raw = options?.disable
  const list = Array.isArray(raw) ? raw.filter((id): id is FeatureID => FEATURE_IDS.includes(id as FeatureID)) : []
  return new Set(list)
}

/** The directory a shell call runs in: its `workdir`, resolved against the session's directory. */
export function shellCwd(workdir: string | undefined, sessionDirectory: string): string {
  if (workdir === undefined) return sessionDirectory
  return isAbsolute(workdir) ? workdir : resolve(sessionDirectory, workdir)
}

/** The advisories for one completed shell call, skip-CI first; `gitWrappers` name the commands read as git. */
export function shellAdvisories(
  command: string,
  cwd: string,
  disabled: ReadonlySet<FeatureID>,
  gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS,
  advise?: (command: string, cwd: string) => string[],
): string[] {
  const out: string[] = []
  if (!disabled.has("skip-ci")) {
    const skip = skipCiAdvisory(command, cwd, gitWrappers)
    if (skip !== undefined) out.push(skip)
  }
  if (!disabled.has("mr-advisory")) {
    const defaultAdvice = (text: string, directory: string) =>
      decideMrAdvisory(text, directory, { conventionalTitle: !disabled.has("mr-title"), gitWrappers })
    out.push(...(advise ?? defaultAdvice)(command, cwd))
  }
  return out
}

/** Test seams; the host never passes these. */
export type Overrides = {
  commitGate?: (command: string, cwd: string) => { reason: string } | undefined
  advise?: (command: string, cwd: string) => string[]
  followUp?: (merges: readonly MergeRequest[]) => Promise<string | undefined>
  reminder?: (cwd: string) => Promise<string | undefined>
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.trunk-dev",
    async setup(ctx) {
      const disabled = readOptions(ctx.options as Record<string, unknown> | undefined)
      const gitWrappers = readGitWrappers(ctx.options as Record<string, unknown> | undefined)
      const gate = overrides.commitGate ?? ((command: string, cwd: string) => decideCommitGate(command, cwd, { gitWrappers }))
      const followUp = overrides.followUp ?? ((merges) => flagCleanupFollowUp(merges, process.env))
      const reminded = new Set<string>()
      /** One lookup: the session's directory, and whether it is a child (`undefined` when the lookup failed). */
      const sessionInfo = (sessionID: string): Promise<{ directory: string; child: boolean | undefined }> =>
        ctx.session
          .get({ sessionID } as never)
          .then((found) => {
            const session = found as { location: { directory: string }; parentID?: string | null }
            return { directory: session.location.directory, child: session.parentID != null }
          })
          .catch(() => ({ directory: ctx.location.directory as string, child: undefined }))
      const sessionDirectory = async (sessionID: string): Promise<string> => (await sessionInfo(sessionID)).directory

      const before = await ctx.tool.hook("execute.before", async (event) => {
        if (disabled.has("commit-gate")) return
        const call = shellCall(event.tool, event.input)
        if (call === undefined) return
        const cwd = shellCwd(call.workdir, await sessionDirectory(event.sessionID))
        let refusal: { reason: string } | undefined
        try {
          refusal = gate(call.command, cwd)
        } catch {
          refusal = undefined
        }
        if (refusal !== undefined) throw new Error(`trunk-dev: ${refusal.reason}`)
      })

      const after = await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed") return
        try {
          const notes: string[] = []
          let merges: MergeRequest[] = []
          const { directory, child } = await sessionInfo(event.sessionID)
          if (event.tool === LAND_TOOL) {
            const landed = landedMerge(event.result.output, directory)
            if (landed !== undefined) merges = [landed]
          } else {
            const call = shellCall(event.tool, event.input)
            if (call === undefined) return
            const cwd = shellCwd(call.workdir, directory)
            if (!disabled.has("session-reminders") && child === false && !reminded.has(event.sessionID)) {
              reminded.add(event.sessionID)
              const note = await (overrides.reminder ?? sessionReminder)(cwd).catch(() => undefined)
              if (note) notes.push(note)
            }
            const exit = shellExit(event.result)
            if (exit !== undefined && exit !== 0) {
              if (notes.length) event.result = appendResultText(event.result, notes.join("\n"))
              return
            }
            notes.push(...shellAdvisories(call.command, cwd, disabled, gitWrappers, overrides.advise))
            if (exit === 0) merges = shellMerges(call.command, cwd)
          }
          if (!disabled.has("flag-cleanup") && merges.length > 0) {
            const note = await followUp(merges).catch(() => undefined)
            if (note !== undefined) notes.push(note)
          }
          if (notes.length > 0) event.result = appendResultText(event.result, notes.join("\n"))
        } catch {
          // Advisories and follow-ups never fail the call they observe.
        }
      })

      const skills = await registerSkills(ctx.skill, SKILL_PATHS)

      return async () => {
        await skills.dispose()
        await after.dispose()
        await before.dispose()
      }
    },
  })
}

export default createPlugin()
