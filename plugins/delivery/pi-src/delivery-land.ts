// The pi extension of delivery's landing: one tool, `delivery_land`. It runs the OpenCode plugin's
// `landPullRequest` (`opencode/src/land.ts`) with its refusals, its at-most-once merge bound to the
// head, its proof and its receipt. The input contract, the shared description and the output come
// from `opencode/src/land-tool.ts`, which the OpenCode tool uses too. The receipt goes to the
// directory `delivery_cleanup` reads (`$DELIVERY_RECEIPTS_DIR`, then `~/.omp/receipts`), and the
// `delivery` key of the user settings file names further GitLab hosts, as for `delivery_cleanup`.
//
// Before a write to the forge (a merge, or the deletion-on-merge setting) it asks the user to
// confirm, naming the request, the head and the method. A session without a UI (a subagent, print
// mode) cannot be asked, so that write is refused instead, with nothing merged or written. Proving
// an already MERGED request writes only the local receipt and asks nothing. No cleanup runs after a
// land: the result's `next` names `delivery_cleanup`. OMP's approval mode may ask before the call too.

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { metadataOf } from "../opencode/src/cleanup-tool.ts"
import { type LandAuthorization, type LandDeps, type LandOutcome, type LandParams, landPullRequest } from "../opencode/src/land.ts"
import { LAND_ACTION, LAND_INPUT, LAND_OUTPUT, landDescription, landOutput } from "../opencode/src/land-tool.ts"
import { callGitlabHosts, type NeutralToolResult, schema, toToolResult } from "./host.ts"

export const DESCRIPTION = landDescription(
  "On pi a merge or setupAutoDelete asks the user first and is refused in a session without a UI; proving an already MERGED request asks nothing. " +
    "No cleanup runs after the land: call delivery_cleanup once next lists it; a landing of another repository is cleaned up from a session in that clone.",
)

/** Test seams; a host passes none. */
export type PiLandDeps = {
  /** Further deps for `landPullRequest` (a runner, a clock, the environment); never the session, the signal or the authorization. */
  land?: Omit<LandDeps, "cwd" | "signal" | "authorize" | "gitlabHosts">
  /** The user settings file whose `delivery` key may name GitLab hosts; a host passes none, so the default path is read. */
  settingsPath?: string
}

/** A forge write the user did not confirm; the call refuses with `reason` and nothing written. */
export class LandUnconfirmed extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** What a landing would write to the forge, in words, or null when it only proves a MERGED request. */
export function forgeWrites(request: LandAuthorization): string | null {
  const writes = [
    ...(request.merge === null ? [] : [`merge ${request.resource} with ${request.merge} at head ${request.head}`]),
    ...(request.setupAutoDelete ? [`enable deletion-on-merge for ${request.resource.replace(/#[^#]*$/, "")}`] : []),
  ]
  return writes.length === 0 ? null : writes.join(" and ")
}

/** The confirmation a forge write asks for. */
export function confirmation(request: LandAuthorization, writes: string): { title: string; message: string } {
  return {
    title: `Land ${request.resource}?`,
    message: `delivery_land will ${writes} on ${request.forge}, then prove the landing and write a landing receipt.`,
  }
}

/**
 * The authorization of one call: a forge write goes ahead only once the user confirms it; without a
 * UI to ask, or when the user declines or the call is stopped while asking, it is refused.
 */
export function authorizer(ctx: Pick<ExtensionContext, "hasUI" | "ui">, signal: AbortSignal | undefined) {
  return async (request: LandAuthorization): Promise<void> => {
    const writes = forgeWrites(request)
    if (writes === null) return
    if (!ctx.hasUI) {
      throw new LandUnconfirmed(
        `confirmation: observed no UI to ask whether to ${writes}, expected a session that can ask the user; pi's delivery_land writes to the forge only after the user confirms, so land it from an interactive session; nothing was merged or written`,
      )
    }
    const { title, message } = confirmation(request, writes)
    const confirmed = await ctx.ui.confirm(title, message, { signal })
    if (signal?.aborted === true) {
      throw new LandUnconfirmed("signal: observed an abort while asking the user to confirm; nothing was merged or written")
    }
    if (!confirmed) {
      throw new LandUnconfirmed(`confirmation: observed the user declined to ${writes}, expected a confirmation; nothing was merged or written`)
    }
  }
}

/** One land in the session at `ctx.cwd`, in the host-neutral result form. */
export async function runLand(
  params: LandParams,
  ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">,
  signal: AbortSignal | undefined,
  deps: PiLandDeps = {},
  gitlabHosts: readonly string[] = [],
): Promise<NeutralToolResult> {
  let outcome: LandOutcome
  try {
    outcome = await landPullRequest(params, { ...deps.land, cwd: ctx.cwd, gitlabHosts, signal, authorize: authorizer(ctx, signal) })
  } catch (error) {
    if (!(error instanceof LandUnconfirmed)) throw error
    outcome = { ok: false, reason: error.reason, text: `delivery_land refused: ${error.reason}` }
  }
  const output = landOutput(outcome)
  return { output, content: outcome.text, metadata: metadataOf(output) }
}

/** OMP's approval tier for a tool (omp://approval-mode.md); pi ignores the key. */
export type LandTool = ToolDefinition & { approval: "exec" }

export function landTool(deps: PiLandDeps = {}): LandTool {
  return {
    name: LAND_ACTION,
    label: "Delivery: land a reviewed PR",
    description: DESCRIPTION,
    parameters: schema(LAND_INPUT),
    outputSchema: schema(LAND_OUTPUT),
    // It runs git, gh and glab and may merge a pull request, so OMP's approval mode governs it as exec.
    approval: "exec",
    execute: async (_id, params, signal, _onUpdate, ctx) =>
      toToolResult(await runLand(params as LandParams, ctx, signal, deps, callGitlabHosts(ctx, deps.settingsPath))),
  }
}

export default function deliveryLand(pi: ExtensionAPI): void {
  pi.registerTool(landTool())
}
