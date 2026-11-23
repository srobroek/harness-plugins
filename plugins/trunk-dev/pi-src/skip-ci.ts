import { type ExtensionAPI, isBashToolResult, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { skipCiAdvisory } from "../shared/skip-ci.js";

/** Append the skip-CI reminder to a completed pi bash result, when warranted. */
export function skipCiResult(event: ToolResultEvent): ToolResultEvent["content"] | undefined {
  if (!isBashToolResult(event)) return undefined
  const command: unknown = event.input.command
  if (typeof command !== "string") return undefined
  const advisory = skipCiAdvisory(command)
  if (advisory === undefined) return undefined
  return [...event.content, { type: "text", text: advisory }]
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    const content = skipCiResult(event)
    return content === undefined ? undefined : { content }
  })
}
