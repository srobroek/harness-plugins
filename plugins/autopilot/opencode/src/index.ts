/**
 * The OpenCode adapter: the host over the plugin context, the tools, the `/autopilot` command and
 * the hooks. The run itself is `shared/autopilot.ts`.
 */

import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { watchEvents } from "@srobroek/opencode-lib/event-watch"
import { hostWarn } from "@srobroek/opencode-lib/host-log"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { Autopilot, type AutopilotHost, type Deps, ID, type Json, realPath } from "../../shared/autopilot.ts"
import { type SessionView, sessionBusy } from "../../shared/gather.ts"
import { LOG_INPUT_SCHEMA } from "../../shared/journal.ts"
import {
  COMMAND_DESCRIPTION,
  EXPORT_REVIEW_DESCRIPTION,
  EXPORT_REVIEW_INPUT,
  type ExportReviewInput,
  LOG_DESCRIPTION,
  MERGE_DESCRIPTION,
  MERGE_INPUT,
  type MergeInput,
  REVIEW_DESCRIPTION,
  REVIEW_INPUT,
  type ReviewInput,
  STATUS_DESCRIPTION,
  STATUS_INPUT,
  type StatusInput,
} from "../../shared/tools.ts"

const SKILL_FILE = fileURLToPath(new URL("../skills/autopilot/SKILL.md", import.meta.url))

/** A bound on child-session pages per tick (100 sessions each). */
const MAX_CHILD_PAGES = 50

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The autopilot host over an OpenCode plugin context. Every call goes to `ctx` at call time. */
export function openCodeHost(ctx: Context): AutopilotHost {
  const info = (sessionID: string) => ctx.session.get({ sessionID }) as Promise<SessionView | undefined>
  return {
    profile: { ticks: "automation", askFallback: "fall back to the question tool" },
    storage: {
      get: (key) => ctx.storage.get(key) as Promise<Json | undefined>,
      set: (key, value) => ctx.storage.set(key, value as never),
      remove: (key) => ctx.storage.remove(key),
      scan: (options) => ctx.storage.scan(options) as Promise<{ entries: { key: string; value: Json }[]; next?: string }>,
    },
    get directory() {
      return ctx.location.directory
    },
    parentOf: (sessionID) =>
      info(sessionID).then(
        (found) => (found === undefined ? undefined : typeof found.parentID === "string" && found.parentID !== "" ? found.parentID : null),
        () => undefined,
      ),
    directoryOf: (sessionID) =>
      info(sessionID).then(
        (found) => found?.location?.directory as string | undefined,
        () => undefined,
      ),
    busy: (sessionID) =>
      info(sessionID).then(
        (found) => sessionBusy(found),
        () => false,
      ),
    async children(sessionID) {
      const sessions: SessionView[] = []
      let page = await ctx.session.list({ parentID: sessionID, limit: 100 }).catch(() => undefined)
      for (let pages = 0; page && pages < MAX_CHILD_PAGES; pages++) {
        sessions.push(...(page.data as SessionView[]))
        const next = page.cursor?.next
        if (!next) return { sessions, complete: true }
        page = await ctx.session.list({ cursor: next, limit: 100 }).catch(() => undefined)
      }
      return { sessions, complete: false }
    },
    messages: (sessionID) => ctx.session.context({ sessionID }),
    prompt: async (sessionID, text) => {
      await ctx.session.prompt({ sessionID, text })
    },
    notify: async (input) => {
      await ctx.session.synthetic(input)
    },
    authorize: async (input) => {
      await ctx.permission.assert(input as never)
    },
    async worktrees() {
      const project = ctx.location.project as { id?: string; directory?: string; canonical?: string } | undefined
      const entries = project?.id === undefined ? [] : await ctx.worktree.list({ projectID: project.id } as never).catch(() => [])
      const real = (paths: (string | undefined)[]) => new Set(paths.flatMap((path) => (path === undefined ? [] : (realPath(path) ?? []))))
      return { listed: real(entries.map((entry) => entry.directory)), primary: real([project?.directory, project?.canonical]) }
    },
    // One OpenCode server hosts every session of the project.
    hosts: () => true,
    reviews: {
      hasAgent: (agentID) =>
        ctx.agent.get({ agentID } as never).then(
          (output) => {
            const value = output as unknown as { data?: { id?: unknown } } | { id?: unknown } | undefined
            return (value && "data" in value ? value.data : (value as { id?: unknown } | undefined))?.id === agentID
          },
          () => false,
        ),
      create: ({ directory, ...input }) => ctx.session.create({ ...input, location: { directory } }),
      remove: async (sessionID) => {
        await ctx.session.remove({ sessionID })
      },
      interrupt: async (sessionID) => {
        await ctx.session.interrupt({ sessionID })
      },
      info: (sessionID) => ctx.session.get({ sessionID }),
      prompt: async (input) => {
        await ctx.session.prompt(input)
      },
    },
  }
}

export async function setupAutopilot(ctx: Context, deps: Deps = {}): Promise<() => Promise<void>> {
  // The host logger is bound to the fiber that runs setup, so take it before the first await.
  const warn = deps.warn ?? hostWarn(ID)
  const pilot = new Autopilot(openCodeHost(ctx), { ...deps, warn })
  await pilot.load()
  const registrations: { dispose: () => Promise<void> }[] = []
  const report = (what: string) => (error: unknown) => warn(`${what} failed`, { error: errorText(error) })
  registrations.push(
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "autopilot_status",
        description: STATUS_DESCRIPTION,
        input: STATUS_INPUT,
        output: { type: "object" },
        options: { codemode: true },
        execute: async (input, tool) => {
          const output = await pilot.status(tool.sessionID, input as StatusInput)
          return { output, content: JSON.stringify(output, null, 2) }
        },
      })
      editor.add({
        name: "autopilot_log",
        description: LOG_DESCRIPTION,
        input: LOG_INPUT_SCHEMA,
        execute: async (input, tool) => ({ content: await pilot.log(tool.sessionID, input) }),
      })
      editor.add({
        name: "autopilot_merge",
        description: MERGE_DESCRIPTION,
        input: MERGE_INPUT,
        execute: async (input, tool) => ({ content: await pilot.merge(tool.sessionID, input as MergeInput) }),
      })
      editor.add({
        name: "autopilot_review",
        description: REVIEW_DESCRIPTION,
        input: REVIEW_INPUT,
        execute: async (input, tool) => ({ content: await pilot.review(tool.sessionID, input as ReviewInput) }),
      })
      editor.add({
        name: "autopilot_export_review",
        description: EXPORT_REVIEW_DESCRIPTION,
        input: EXPORT_REVIEW_INPUT,
        execute: async (input, tool) => ({ content: await pilot.exportReview(tool.sessionID, input as ExportReviewInput) }),
      })
    }),
  )
  registrations.push(
    await ctx.command.transform((editor) => {
      editor.add({
        name: "autopilot",
        description: COMMAND_DESCRIPTION,
        execute: async (input) => {
          const text = await pilot.command(input.sessionID, input.prompt.text ?? "")
          await ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text, delivery: input.delivery })
        },
      })
    }),
  )
  registrations.push(await ctx.tool.hook("execute.before", (event) => pilot.beforeTool(event.tool, event.sessionID)))
  registrations.push(await ctx.permission.hook("evaluate", (event) => pilot.evaluate(event).catch(report("permission hook"))))
  registrations.push(await ctx.session.hook("experimental.idle", (event) => pilot.idle(event.sessionID).catch(report("idle hook"))))
  registrations.push(await registerSkills(ctx.skill, [SKILL_FILE]))
  const watching = watchEvents<unknown>({
    subscribe: (signal) => ctx.event.subscribe({ signal })[Symbol.asyncIterator](),
    handle: (value) => {
      pilot.activity.observe(value)
      const event = value as { type?: string; data?: { sessionID?: string } }
      if (event.type === "session.compaction.ended" && typeof event.data?.sessionID === "string") void pilot.compacted(event.data.sessionID).catch(report("compaction recovery"))
    },
    warn,
    label: "autopilot event",
    ...deps.watch,
  })
  return async () => {
    watching.stop()
    pilot.dispose()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}

export default Plugin.define({ id: ID, setup: (ctx) => setupAutopilot(ctx) })
