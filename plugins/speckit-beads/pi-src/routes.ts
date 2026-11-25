/**
 * pi's side of the routes in `../opencode/src/skills.ts` and the tasks.md guard: which typed
 * command or read file a route applies to, the text it becomes, and pi's refusal wording. Pure;
 * `speckit-beads.ts` probes beads and applies the results to pi's events.
 *
 * Spec-kit's pi integration writes its commands as prompt templates (`.pi/prompts/speckit.*.md`,
 * typed as `/speckit.<name>`); other integrations write skills (`speckit-<name>/SKILL.md`, typed
 * as `/skill:speckit-<name>`). pi expands both after its `input` event, so a typed command is
 * routed there, and a file the model reads is routed in `tool_result`.
 */

import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import {
  ANALYZE_SKILLS,
  IMPLEMENT_ROUTE,
  IMPLEMENT_SKILLS,
  rewriteSkill,
  type SkillRouting,
  skillRoute,
  TASKSTOISSUES_REASON,
  TASKSTOISSUES_SKILLS,
} from "../opencode/src/skills.ts"
import { GUARD_REASON } from "../opencode/src/tasks-guard.ts"

/** The system prompt section that carries the workflow instructions. */
export const WORKFLOW_SECTION = "speckit_workflow"

/** The custom message type of the analyze note. */
export const MESSAGE_TYPE = "speckit-beads"

/** pi's tasks.md refusal: the shared reason plus where to switch the guard off. */
export function guardReason(settingsPath: string): string {
  return `${GUARD_REASON} Disable: set "tasksGuard": false under the "speckit-beads" key of ${settingsPath}`
}

/** pi's taskstoissues refusal. */
export function tasksToIssuesReason(settingsPath: string): string {
  return `${TASKSTOISSUES_REASON} Disable: set "blockTasksToIssues": false under the "speckit-beads" key of ${settingsPath}`
}

/** A typed spec-kit command: its prompt or skill id and the text after it. */
export type Command = { id: string; args: string }

const ROUTED: ReadonlySet<string> = new Set([...IMPLEMENT_SKILLS, ...ANALYZE_SKILLS, ...TASKSTOISSUES_SKILLS])

/** The command `text` invokes when it is one a route may apply to, else `undefined`. */
export function routedCommand(text: string): Command | undefined {
  const match = /^\/(?:skill:)?(speckit[.-][\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const id = match?.[1]
  if (id === undefined || !ROUTED.has(id)) return undefined
  return { id, args: match?.[2]?.trim() ?? "" }
}

export type InputRoute =
  /** Send this text instead; it is no command, so pi expands nothing. */
  | { kind: "transform"; text: string }
  /** Do not run the command; tell the user why. */
  | { kind: "refuse"; reason: string }
  /** Let the command expand, and add the analyze note to the run it starts. */
  | { kind: "analyze" }

/** What a typed command becomes under `routing`, or `undefined` to run it as upstream wrote it. */
export function inputRoute(command: Command, routing: SkillRouting, refusal: string): InputRoute | undefined {
  const route = skillRoute(command.id, routing)
  if (route === "implement")
    return { kind: "transform", text: command.args === "" ? IMPLEMENT_ROUTE : `${IMPLEMENT_ROUTE}\n\nUser input: ${command.args}` }
  if (route === "taskstoissues") return { kind: "refuse", reason: refusal }
  if (route === "analyze") return { kind: "analyze" }
  return undefined
}

/** A file tool's path as pi resolves it: a leading `@` dropped, `~` expanded, relative to `cwd`. */
export function toolPath(path: string, cwd: string): string {
  const plain = path.startsWith("@") ? path.slice(1) : path
  const expanded = plain === "~" ? homedir() : plain.startsWith("~/") ? `${homedir()}${plain.slice(1)}` : plain
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

/** The routed command a read file holds: a `prompts/speckit.<name>.md` template or a `speckit-<name>/SKILL.md`. */
export function readCommand(path: string): string | undefined {
  const normal = path.replaceAll("\\", "/")
  const id =
    /(?:^|\/)prompts\/(speckit\.[^/]+)\.md$/.exec(normal)?.[1] ?? /(?:^|\/)(speckit-[^/]+)\/SKILL\.md$/.exec(normal)?.[1]
  return id !== undefined && ROUTED.has(id) ? id : undefined
}

/** The text a read of command `id` returns under `routing`, or `undefined` to leave `text` as read. */
export function routedRead(id: string, text: string, routing: SkillRouting, refusal: string): string | undefined {
  return rewriteSkill({ id, content: text }, routing, refusal)?.content
}

/** A tool call's input with its `path` as pi resolves it, for the shared tasks.md guard. */
export function guardInput(input: unknown, cwd: string): unknown {
  if (input === null || typeof input !== "object") return input
  const path = (input as { path?: unknown }).path
  return typeof path === "string" && path !== "" ? { ...input, path: toolPath(path, cwd) } : input
}
