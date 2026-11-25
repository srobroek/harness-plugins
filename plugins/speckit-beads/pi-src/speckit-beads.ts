/**
 * The speckit-beads plugin on pi: the `speckit_setup`, `speckit_start` and `speckit_commit`
 * tools, the tasks.md guard on `bash`, `edit` and `write`, the implement, analyze and
 * taskstoissues routes, and the workflow instructions as a system prompt section. The decisions
 * live in the OpenCode modules and `routes.ts`; this file only wires them to pi's events.
 *
 * Options come from the `speckit-beads` key of pi's user settings, `<agentDir>/settings.json`, in
 * the shape of the OpenCode `options` block; `agents` and `specAgent` do not apply, because
 * pi-subagents lists the package's agents. A project's `.pi/settings.json` is not read: it could
 * switch the guards off.
 */

import { join } from "node:path"
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { repositoryRoot } from "@srobroek/opencode-lib/external-directories"
import { loadPiPluginSettings, PI_SETTINGS_FILE } from "@srobroek/opencode-lib/pi-settings"
import type { TSchema } from "typebox"
import WORKFLOW from "../opencode/instructions/speckit-workflow.md" with { type: "text" }
import { beadsActive } from "../opencode/src/beads.ts"
import { COMMIT_DESCRIPTION, COMMIT_INPUT, COMMIT_TOOL, executeCommit } from "../opencode/src/commit.ts"
import { parseOptions } from "../opencode/src/options.ts"
import { PI_INTEGRATION } from "../opencode/src/setup.ts"
import { ANALYZE_NOTE, type SkillRouting } from "../opencode/src/skills.ts"
import { type BeadsProbe, decideToolCall } from "../opencode/src/tasks-guard.ts"
import {
  executeSetup,
  executeStart,
  SETUP_DESCRIPTION,
  SETUP_TOOL,
  START_DESCRIPTION,
  START_INPUT,
  START_TOOL,
  setupInput,
  setupTarget,
  type ToolOutput,
  toolDirectory,
} from "../opencode/src/tools.ts"
import { speckitWorkspace, usesSpeckit } from "../opencode/src/workflow.ts"
import {
  guardInput,
  guardReason,
  inputRoute,
  MESSAGE_TYPE,
  readCommand,
  routedCommand,
  routedRead,
  tasksToIssuesReason,
  toolPath,
  WORKFLOW_SECTION,
} from "./routes.ts"

/** Seams for tests; production passes none. */
export type SpeckitPiDeps = {
  probe?: BeadsProbe
  /** Replaces `<agentDir>/settings.json`. */
  settingsPath?: string
}

/** The tools share their JSON schemas with OpenCode; pi takes them as they are. */
const schema = (value: object) => value as unknown as TSchema

const firstLine = (text: string) => text.split("\n", 1)[0] ?? text

const toolResult = (output: ToolOutput) => ({
  content: [{ type: "text" as const, text: output.content }],
  details: output.metadata,
})

/** A message for the user: a warning in the UI, else one stderr line (as in `pi -p`). */
function notify(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning")
  else process.stderr.write(`${message}\n`)
}

export function setupSpeckitPi(pi: ExtensionAPI, deps: SpeckitPiDeps = {}): void {
  const settingsPath = deps.settingsPath ?? join(getAgentDir(), PI_SETTINGS_FILE)
  const loaded = loadPiPluginSettings(settingsPath, "speckit-beads", "the defaults apply")
  const options = parseOptions(loaded.options, PI_INTEGRATION)
  const probe = deps.probe ?? ((directory: string) => beadsActive(directory))
  const workflow = WORKFLOW.trim()
  const refusal = tasksToIssuesReason(settingsPath)
  const workspaceOf = (directory: string) => speckitWorkspace(directory, repositoryRoot(directory))
  // Beads activity in the session directory decides every route, as the location does on OpenCode.
  const routing = async (cwd: string): Promise<SkillRouting> => {
    const active = await probe(cwd)
    return {
      implement: active && options.implementRedirect,
      analyze: active && options.implementRedirect,
      taskstoissues: active && options.blockTasksToIssues,
    }
  }
  // A typed `/speckit.analyze` expands after the `input` event; the run it starts gets the note.
  let analyzePending = false
  // Whether the current run's system prompt carries the workflow section.
  let workflowShown = false

  pi.on("session_start", (_event, ctx) => {
    if (loaded.warning !== undefined) notify(ctx, loaded.warning)
  })

  pi.on("input", async (event, ctx) => {
    analyzePending = false
    const command = routedCommand(event.text)
    if (command === undefined) return undefined
    const route = inputRoute(command, await routing(ctx.cwd), refusal)
    if (route === undefined) return undefined
    if (route.kind === "analyze") {
      analyzePending = true
      return undefined
    }
    if (route.kind === "refuse") {
      notify(ctx, route.reason)
      return { action: "handled" }
    }
    return { action: "transform", text: route.text }
  })

  pi.on("before_agent_start", (event, ctx) => {
    // pi diffs the sections against what the model has, so setting it on each run keeps the prompt cache.
    workflowShown = options.workflow && workspaceOf(ctx.cwd) !== undefined
    if (workflowShown) event.systemPromptOptions.sections[WORKFLOW_SECTION] = workflow
    const analyze = analyzePending && event.messageType === "user"
    analyzePending = false
    return analyze ? { message: { customType: MESSAGE_TYPE, content: ANALYZE_NOTE, display: true } } : undefined
  })

  if (options.tasksGuard)
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash" && event.toolName !== "edit" && event.toolName !== "write") return undefined
      let reason: string | undefined
      try {
        reason = await decideToolCall(event.toolName, guardInput(event.input, ctx.cwd), ctx.cwd, probe, guardReason(settingsPath))
      } catch {
        // Fails open, as on OpenCode: a guard that cannot decide does not stop the call.
        return undefined
      }
      return reason === undefined ? undefined : { block: true, reason }
    })

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return undefined
    const path = event.input.path
    if (typeof path !== "string" || path === "") return undefined
    const id = readCommand(toolPath(path, ctx.cwd))
    if (id === undefined) return undefined
    const text = event.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    const routed = routedRead(id, text, await routing(ctx.cwd), refusal)
    return routed === undefined ? undefined : { content: [{ type: "text" as const, text: routed }] }
  })

  pi.registerTool({
    name: SETUP_TOOL,
    label: "SpecKit setup",
    description: SETUP_DESCRIPTION,
    promptSnippet: firstLine(SETUP_DESCRIPTION),
    parameters: schema(setupInput(options.integration)),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = toolDirectory(params, ctx.cwd, workspaceOf)
      const output = await executeSetup(params, cwd, options.integration, signal)
      // A run that started before `.specify/` existed has no workflow section; the result carries it.
      if (options.workflow && !workflowShown && usesSpeckit(setupTarget(params, cwd)))
        return toolResult({ ...output, content: `${output.content}\n\n${workflow}` })
      return toolResult(output)
    },
  })

  pi.registerTool({
    name: START_TOOL,
    label: "SpecKit start",
    description: START_DESCRIPTION,
    promptSnippet: firstLine(START_DESCRIPTION),
    parameters: schema(START_INPUT),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return toolResult(await executeStart(params, toolDirectory(params, ctx.cwd, workspaceOf), signal))
    },
  })

  pi.registerTool({
    name: COMMIT_TOOL,
    label: "SpecKit commit",
    description: COMMIT_DESCRIPTION,
    promptSnippet: firstLine(COMMIT_DESCRIPTION),
    parameters: schema(COMMIT_INPUT),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await executeCommit(params, toolDirectory(undefined, ctx.cwd, workspaceOf)))
    },
  })
}

export default function (pi: ExtensionAPI): void {
  setupSpeckitPi(pi)
}
