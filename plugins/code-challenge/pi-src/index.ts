// The Pi extension of code-challenge: the four challenge_* tools and the /code-challenge command,
// registered through Pi's ExtensionAPI over the same handlers the OpenCode plugin calls. OMP loads
// the same bundle: `scripts/build.ts` builds it to pi/extensions/index.js and copies it to
// omp/extensions/index.js. Skills, agents and formulas are plain files in the omp tree.
//
// Only types come from the host package, so the bundle imports nothing from Pi or OMP at runtime.

import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { TSchema } from "typebox"
import { COMMAND, COMMAND_DESCRIPTION, challengePrompt } from "../opencode/src/command.ts"
import { runSetup, SETUP_DESCRIPTION, SETUP_INPUT, SETUP_TOOL } from "../opencode/src/formulas.ts"
import { LIB_FACTS_DESCRIPTION, LIB_FACTS_INPUT, LIB_FACTS_TOOL, runLibFacts } from "../opencode/src/lib-facts/index.ts"
import { type AskConsent, consentMessage, runScanTool, SCAN_DESCRIPTION, SCAN_INPUT, SCAN_TOOL, type ScanDeps } from "../opencode/src/scan/index.ts"
import type { ToolCall, ToolOutcome } from "../opencode/src/tool-call.ts"
import { runValidate, VALIDATE_DESCRIPTION, VALIDATE_INPUT, VALIDATE_TOOL } from "../opencode/src/validate.ts"

/** How long the scan consent prompt waits for an answer before it counts as a refusal. */
export const CONSENT_TIMEOUT_MS = 120_000

/** OMP's approval tier for a tool (omp://approval-mode.md). Pi ignores the key. */
export type Approval = "read" | "write" | "exec"

/** A registered tool: Pi's definition plus the tier OMP's approval mode reads. */
export type ChallengeTool = ToolDefinition & { approval: Approval }

/** The part of a tool call's host context the handlers and the consent gate read. */
export type ChallengeContext = Pick<ExtensionToolContext, "cwd" | "hasUI"> & { ui: Pick<ExtensionToolContext["ui"], "confirm"> }

/** The host form of a handler's result: the same text as one text block, the same metadata as `details`. */
export function toToolResult(outcome: ToolOutcome): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: outcome.content }], details: outcome.metadata }
}

/** A call's host context as the handlers read it: the session cwd is the session directory. */
function toolCall(ctx: ChallengeContext, signal: AbortSignal | undefined): ToolCall {
  return { directory: async () => ctx.cwd, signal }
}

/**
 * The scan consent: an explicit confirmation that names the root and every risky recipe. Without
 * an interactive UI (print mode, headless subagents) nobody can approve, so it refuses.
 */
export function scanConsent(ctx: ChallengeContext, signal: AbortSignal | undefined): AskConsent {
  return async ({ root, risks }) => {
    signal?.throwIfAborted()
    const unscanned = "no analyzer ran; pass staticOnly to scan without these recipes"
    if (!ctx.hasUI) throw new Error(`${SCAN_TOOL}: consent needs an interactive session to approve ${risks.map((r) => r.recipe).join(", ")}; ${unscanned}`)
    const approved = await ctx.ui.confirm(`${SCAN_TOOL}: run code that is not static analysis?`, consentMessage(root, risks), {
      signal,
      timeout: CONSENT_TIMEOUT_MS,
    })
    if (!approved) throw new Error(`${SCAN_TOOL}: consent refused; ${unscanned}`)
  }
}

// The tool inputs are the OpenCode JSON Schemas; Pi and OMP both take a plain JSON Schema object.
const schema = (input: object) => input as TSchema

/** The four tools; `deps` are the scan's test seams, which no host passes. */
export function challengeTools(deps: ScanDeps = {}): ChallengeTool[] {
  return [
    {
      name: SETUP_TOOL,
      label: "Code challenge: install formulas",
      description: SETUP_DESCRIPTION,
      parameters: schema(SETUP_INPUT),
      // Writes .beads/formulas/; the host's approval mode decides whether to ask, as OpenCode's permission does.
      approval: "write",
      execute: async (_id, params, signal, _onUpdate, ctx) => toToolResult(await runSetup(params, toolCall(ctx, signal))),
    },
    {
      name: LIB_FACTS_TOOL,
      label: "Code challenge: library facts",
      description: LIB_FACTS_DESCRIPTION,
      parameters: schema(LIB_FACTS_INPUT),
      approval: "read",
      execute: async (_id, params, signal) => toToolResult(await runLibFacts(params, { signal })),
    },
    {
      name: VALIDATE_TOOL,
      label: "Code challenge: validate run",
      description: VALIDATE_DESCRIPTION,
      parameters: schema(VALIDATE_INPUT),
      approval: "read",
      execute: async (_id, params, signal, _onUpdate, ctx) => toToolResult(await runValidate(params, toolCall(ctx, signal))),
    },
    {
      name: SCAN_TOOL,
      label: "Code challenge: scan",
      description: SCAN_DESCRIPTION,
      parameters: schema(SCAN_INPUT),
      // Analyzers execute, so OMP's tier is exec and its approval mode applies as usual. The consent
      // for recipes that run repository or downloaded code is scanConsent, which names those recipes
      // and asks in every approval mode; a host prompt policy could not name them.
      approval: "exec",
      execute: async (_id, params, signal, _onUpdate, ctx) =>
        toToolResult(await runScanTool(params, { ...toolCall(ctx, signal), consent: scanConsent(ctx, signal) }, deps)),
    },
  ]
}

/** Register the tools and the command. */
export function registerCodeChallenge(pi: Pick<ExtensionAPI, "registerTool" | "registerCommand" | "sendUserMessage">, deps: ScanDeps = {}): void {
  for (const tool of challengeTools(deps)) pi.registerTool(tool)
  pi.registerCommand(COMMAND, {
    description: COMMAND_DESCRIPTION,
    handler: async (args) => pi.sendUserMessage(challengePrompt(args, "pi")),
  })
}

export default function codeChallenge(pi: ExtensionAPI): void {
  registerCodeChallenge(pi)
}
