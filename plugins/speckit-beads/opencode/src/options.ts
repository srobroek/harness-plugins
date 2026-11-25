/**
 * The plugin's options, shared by every harness: OpenCode passes them as the plugin's
 * `options` block, pi reads the same shape from the `speckit-beads` key of `<agentDir>/settings.json`.
 */

import { DEFAULT_INTEGRATION } from "./setup.ts"
import { type SpecAgentSetting, specAgentSetting } from "./spec-agent.ts"

export type SpeckitOptions = {
  /** spec-kit integration `speckit_setup` passes to `specify init`. Default: the harness's own. */
  integration: string
  /** Refuse writes of `specs/*\/tasks.md` where beads is active. Default true. */
  tasksGuard: boolean
  /** Where beads is active, replace the implement command with the beads route and point analyze at the task beads. Default true. */
  implementRedirect: boolean
  /** Refuse the taskstoissues commands where beads is active. Default true. */
  blockTasksToIssues: boolean
  /** Add the workflow instructions to sessions in a SpecKit repository. Default true. */
  workflow: boolean
  /** Register the speckit-sync and speckit-verify subagents (OpenCode). Default true. */
  agents: boolean
  /** Register the primary `spec` agent (OpenCode): `auto` (default) only where `.specify/` exists, or always / never. */
  specAgent: SpecAgentSetting
}

export function parseOptions(
  raw: Readonly<Record<string, unknown>> | undefined,
  defaultIntegration: string = DEFAULT_INTEGRATION,
): SpeckitOptions {
  const options = raw ?? {}
  return {
    integration:
      typeof options.integration === "string" && options.integration.trim() !== ""
        ? options.integration.trim()
        : defaultIntegration,
    tasksGuard: options.tasksGuard !== false,
    implementRedirect: options.implementRedirect !== false,
    blockTasksToIssues: options.blockTasksToIssues !== false,
    workflow: options.workflow !== false,
    agents: options.agents !== false,
    specAgent: specAgentSetting(options.specAgent),
  }
}
