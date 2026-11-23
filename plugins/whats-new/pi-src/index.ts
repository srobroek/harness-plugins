import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import registerReportOnlyGate from "./report-only-gate.js"
import registerVersionGapScan from "./version-gap-scan.js"

export { blocksWhatsNewToolCall, isWhatsNewWorkflow, REPORT_ONLY_REASON, reportOnlyBlockReason } from "./report-only-gate.js"
export { scanVersionGaps, versionGapScanParameters } from "./version-gap-scan.js"

export default function registerWhatsNew(pi: ExtensionAPI): void {
  registerVersionGapScan(pi)
  registerReportOnlyGate(pi)
}
