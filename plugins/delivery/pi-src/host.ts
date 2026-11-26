// What both pi delivery tools share: the `delivery` key of the user settings file, the host form of a
// tool result and the JSON Schema cast. Only types and `getAgentDir` come from the host package, so a
// bundle imports nothing else from pi or OMP at runtime; OMP loads the bundles unchanged.

import { join } from "node:path"
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { loadPiPluginSettings, PI_SETTINGS_FILE } from "@srobroek/opencode-lib/pi-settings"
import type { TSchema } from "typebox"
import { parseGitlabHosts } from "../opencode/src/forge-adapter.ts"

/** A tool result in the host-neutral form the OpenCode tools return too. */
export type NeutralToolResult = { output: Record<string, unknown>; content: string; metadata: Record<string, unknown> }

/**
 * The GitLab hosts named under the `delivery` key of pi's settings file, and the warning when that key
 * could not be read. Absent or unusable, only the built-in hosts are recognized.
 */
export function deliverySettings(path: string): { gitlabHosts: readonly string[]; warning?: string } {
  const loaded = loadPiPluginSettings(path, "delivery", "only the built-in GitLab hosts are recognized")
  return { gitlabHosts: parseGitlabHosts(loaded.options.gitlabHosts), warning: loaded.warning }
}

/**
 * The GitLab hosts for one call, read fresh from `path` (default: the user settings file), with the
 * warning about an unusable `delivery` key shown when the session has a UI to show it.
 */
export function callGitlabHosts(ctx: Pick<ExtensionContext, "hasUI" | "ui">, path?: string): readonly string[] {
  const settings = deliverySettings(path ?? join(getAgentDir(), PI_SETTINGS_FILE))
  if (settings.warning !== undefined && ctx.hasUI) ctx.ui.notify(settings.warning, "warning")
  return settings.gitlabHosts
}

/** The host form of a result: the text as one block, the metadata as `details`, the output as `structuredContent`. */
export function toToolResult(result: NeutralToolResult): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: result.content }],
    details: result.metadata,
    structuredContent: result.output as AgentToolResult["structuredContent"],
  }
}

/** The OpenCode tools' JSON Schemas as pi parameters; pi and OMP both take a plain JSON Schema object. */
export const schema = (value: object): TSchema => value as unknown as TSchema
