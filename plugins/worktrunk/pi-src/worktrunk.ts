import { isAbsolute, resolve } from "node:path"
import { StringEnum } from "@earendil-works/pi-ai"
import {
  type ExtensionAPI,
  isToolCallEventType,
  type ToolCallEvent,
  type ToolCallEventResult,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { decideMergePolicy, type Probes } from "../shared/merge-gate.js"
import { CHECK_IDS, Context, type ContextOptions, type Report, runPreflight } from "../shared/preflight.js"
import { namesSwitchCommand, SWITCH_TIMEOUT_MS } from "../shared/switch-timeout.js"

/** pi's bash `timeout` is in seconds. */
export const SWITCH_TIMEOUT_SECONDS = SWITCH_TIMEOUT_MS / 1000

/**
 * The longer timeout for a bash call that runs `wt switch` with a shorter one, so its
 * foreground hooks are not killed half-way; `undefined` when it needs no change. pi's
 * bash tool has no default timeout, so a call without one is left alone.
 */
export function switchTimeout(input: { command: string; timeout?: number }): number | undefined {
  if (input.timeout === undefined || input.timeout >= SWITCH_TIMEOUT_SECONDS) return undefined
  return namesSwitchCommand(input.command) ? SWITCH_TIMEOUT_SECONDS : undefined
}

/**
 * The merge-policy block for a bash call, or `undefined`. A probe that throws anything
 * but a timeout propagates, and pi blocks a call whose `tool_call` handler throws.
 */
export async function mergeGateBlock(
  event: ToolCallEvent,
  cwd: string,
  probes?: Probes,
): Promise<ToolCallEventResult | undefined> {
  if (!isToolCallEventType("bash", event) || !/merge/.test(event.input.command)) return undefined
  const decision = await decideMergePolicy(event.input.command, cwd, probes)
  return decision === undefined ? undefined : { block: true, reason: decision.reason }
}

/** The directory the preflight runs in: `path` (a leading `@` dropped) against the session directory. */
export function preflightDirectory(sessionDirectory: string, path: string | undefined): string {
  const raw = path?.replace(/^@/, "")
  if (!raw) return sessionDirectory
  return isAbsolute(raw) ? raw : resolve(sessionDirectory, raw)
}

const preflightParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Repository directory; defaults to the session directory" })),
  only: Type.Optional(
    Type.Array(StringEnum(CHECK_IDS as [string, ...string[]]), {
      description: "Run only these checks; any non-pass then fails the report",
    }),
  ),
  apply: Type.Optional(
    Type.Boolean({
      description:
        "Approve pending hooks when hook-approvals fails, and append missing provisioning hooks to .config/wt.toml",
    }),
  ),
})

/** Test seams; pi never passes these. */
export type Overrides = { probes?: Probes; context?: Omit<ContextOptions, "mutateFile"> }

export function createExtension(overrides: Overrides = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (!isToolCallEventType("bash", event)) return undefined
      const longer = switchTimeout(event.input)
      if (longer !== undefined) event.input.timeout = longer
      return mergeGateBlock(event, ctx.cwd, overrides.probes)
    })

    pi.registerTool({
      name: "worktrunk_preflight",
      label: "Worktrunk preflight",
      description:
        "Run the deterministic Worktrunk preflight checks (wt, hook approvals, config keys, default branch, merge evidence, provisioning, node_modules, commit generation). Read-only unless apply is set. Returns JSON { ok, summary, checks[{ id, status, detail, fix }] }.",
      promptSnippet: "Run Worktrunk preflight checks before an agent run, focused test or merge",
      promptGuidelines: [
        "Use worktrunk_preflight instead of running the worktrunk-preflight skill's preflight.py through bash.",
      ],
      parameters: preflightParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const context = new Context(preflightDirectory(ctx.cwd, params.path), {
          ...overrides.context,
          mutateFile: (path, write) => withFileMutationQueue(path, async () => write()),
        })
        // pi validated `only` against the check-id enum; pi-ai's enum schema has no TypeBox static type.
        const only = params.only as readonly string[] | undefined
        const report: Report = await runPreflight({ only, apply: params.apply }, context)
        return { content: [{ type: "text", text: JSON.stringify(report) }], details: report }
      },
    })
  }
}

export default createExtension()
