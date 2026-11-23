import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { commandMutates, isDependencyFile } from "../shared/report-only.js"

export const REPORT_ONLY_REASON =
  "blocked by whats-new (report-only): this agent reports what changed and changes nothing itself. Do not " +
  "edit dependency manifests or lockfiles, or run installers or upgrade commands while researching."

const ACTIVE_AGENT = /<active_agent\s+name=["']whats-new["']\s*\/>/

/** pi-subagents tags each native child prompt and names its child session from the selected agent. */
export function isWhatsNewWorkflow(systemPrompt: string, sessionName: string | undefined, isChild: boolean): boolean {
  return isChild && (ACTIVE_AGENT.test(systemPrompt) || sessionName === "whats-new" || sessionName?.startsWith("whats-new: ") === true)
}

export type ToolCallLike = { toolName: string; input: unknown }

export function reportOnlyBlockReason(event: ToolCallLike): string | undefined {
  const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {}
  const target = [input.path, input.file_path].find((value): value is string => typeof value === "string")
  if ((event.toolName === "write" || event.toolName === "edit") && target !== undefined && isDependencyFile(target)) {
    return REPORT_ONLY_REASON
  }
  if (event.toolName === "bash" && typeof input.command === "string" && commandMutates(input.command)) {
    return REPORT_ONLY_REASON
  }
  if (event.toolName === "dep_apply") return REPORT_ONLY_REASON
  return undefined
}

export function blocksWhatsNewToolCall(
  event: ToolCallLike,
  systemPrompt: string,
  sessionName: string | undefined,
  isChild: boolean,
): boolean {
  return isWhatsNewWorkflow(systemPrompt, sessionName, isChild) && reportOnlyBlockReason(event) !== undefined
}

export default function registerReportOnlyGate(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    const header = ctx.sessionManager.getHeader() as { parentSession?: unknown } | undefined
    const child = typeof header?.parentSession === "string"
    const prompt = ctx.getSystemPrompt() ?? ""
    if (!isWhatsNewWorkflow(prompt, pi.getSessionName(), child)) return
    const reason = reportOnlyBlockReason(event)
    return reason ? { block: true, reason } : undefined
  })
}
