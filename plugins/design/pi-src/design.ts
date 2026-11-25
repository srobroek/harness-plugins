import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  chooseScanRunner,
  downloadQuestion,
  type Exec,
  readScanParams,
  resolveTargets,
  runScan,
  SCAN_CAVEAT,
  SCAN_INPUT,
  SCAN_SUMMARY,
  SCAN_TOOL,
  type ScanRunner,
} from "../shared/impeccable.ts"
import { PLAYWRIGHT_SERVER, playwrightHeadless, playwrightMcp } from "./playwright.ts"

/** How to install the prerequisite; the same route as `prerequisites` in plugins/design/package.json. */
export const IMPECCABLE_INSTALL = "mise use -g npm:impeccable"

export const PI_SCAN_DESCRIPTION =
  `${SCAN_SUMMARY}\n` +
  "Runs the impeccable on PATH (the design package's prerequisite) without a prompt. Without it, npx may download " +
  "impeccable and its engine, so the tool asks first, and refuses in a session that cannot ask. " +
  SCAN_CAVEAT

/** Whether a scan runs as is, asks the user first, or is refused. */
export type ScanConsent = "run" | "confirm" | "refuse"

/**
 * An installed impeccable runs a local scan, so it needs no prompt. npx may fetch and run code from
 * the network, so it needs the user's yes, and a session without a UI (a subagent, `pi -p`) cannot give one.
 */
export function scanConsent(runner: ScanRunner, hasUI: boolean): ScanConsent {
  if (runner.kind === "path") return "run"
  return hasUI ? "confirm" : "refuse"
}

const properties = SCAN_INPUT.properties
const parameters = Type.Object(
  {
    targets: Type.Array(Type.String(), { minItems: 1, description: properties.targets.description }),
    noConfig: Type.Optional(Type.Boolean({ description: properties.noConfig.description })),
    viewport: Type.Optional(Type.String({ pattern: properties.viewport.pattern, description: properties.viewport.description })),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: properties.timeoutSeconds.minimum,
        maximum: properties.timeoutSeconds.maximum,
        description: properties.timeoutSeconds.description,
      }),
    ),
  },
  { additionalProperties: false },
)

/** Test seams; pi never passes them. */
export type DesignOverrides = { exec?: Exec; which?: (bin: string) => string | null; makeWorkspace?: () => string }

const text = (value: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: value }], details })

const newWorkspace = () => mkdtempSync(join(tmpdir(), "pi-design-playwright-"))

export function registerDesign(pi: ExtensionAPI, overrides: DesignOverrides = {}): void {
  const which = overrides.which ?? ((bin: string) => Bun.which(bin))
  // The browser's only workspace root lives as long as the session: pi starts the server when the
  // session starts, so the directory is made then, and the session's snapshots and screenshots go
  // with it at shutdown. Loading the extension alone creates nothing.
  let workspace: string | undefined
  pi.on("session_start", () => {
    if (workspace !== undefined) return
    workspace = (overrides.makeWorkspace ?? newWorkspace)()
    pi.registerMcpServer(PLAYWRIGHT_SERVER, playwrightMcp(workspace, playwrightHeadless(process.env, process.platform)))
  })
  pi.on("session_shutdown", () => {
    if (workspace === undefined) return
    rmSync(workspace, { recursive: true, force: true })
    workspace = undefined
  })
  pi.registerTool({
    name: SCAN_TOOL,
    label: "Impeccable Scan",
    description: PI_SCAN_DESCRIPTION,
    parameters,
    async execute(_id, raw, signal, _update, ctx) {
      const params = readScanParams(raw)
      if (typeof params === "string") return text(`${SCAN_TOOL}: ${params}`, { ok: false })
      const runner = chooseScanRunner(which)
      const consent = scanConsent(runner, ctx.hasUI)
      if (consent === "refuse")
        return text(
          `${SCAN_TOOL}: impeccable is not on PATH, and running it through npx needs a confirmation this session cannot show. Install it with \`${IMPECCABLE_INSTALL}\` and start a new session.`,
          { ok: false, status: "refused", runner: runner.kind },
        )
      if (
        consent === "confirm" &&
        !(await ctx.ui.confirm("Download impeccable?", downloadQuestion(resolveTargets(params.targets, ctx.cwd))))
      )
        return text(`${SCAN_TOOL}: scan cancelled`, { ok: false, status: "cancelled", runner: runner.kind })
      const result = await runScan(params, ctx.cwd, signal, overrides.exec, runner)
      return text(result.text, {
        ok: result.ok,
        status: result.status,
        exitCode: result.exitCode,
        findings: result.findings,
        runner: runner.kind,
      })
    },
  })
}

export default function (pi: ExtensionAPI): void {
  registerDesign(pi)
}
