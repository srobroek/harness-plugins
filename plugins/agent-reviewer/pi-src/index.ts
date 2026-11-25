// The Pi extension of agent-reviewer: the gate that holds the pr-reviewer child to its two
// `gh` reads and its skill files. OMP loads the same bundle (`scripts/build.ts` copies it to
// omp/extensions/index.js); there it never acts, because the OMP pr-reviewer has no shell or read
// tool and OMP child prompts carry no pi-subagents agent tag.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import registerPrReviewerGate from "./pr-reviewer-gate.ts"

export { COMMAND_REASON, PR_REVIEWER, prReviewerBlockReason, READ_REASON, skillDirectories } from "./pr-reviewer-gate.ts"

export default function agentReviewer(pi: ExtensionAPI): void {
  registerPrReviewerGate(pi)
}
