import { downloadQuestion, SCAN_CAVEAT, SCAN_SUMMARY, SCAN_TOOL } from "../../shared/impeccable.ts"

export * from "../../shared/impeccable.ts"

export const SCAN_DESCRIPTION =
  `${SCAN_SUMMARY}\n` +
  "Runs npx --yes impeccable detect --json. Your permission config controls the run; the boolean option confirmScan: true adds a prompt, because npx " +
  `may download impeccable and its engine. ${SCAN_CAVEAT}`

type Evaluation = { action: string; resources: ReadonlyArray<string>; effect: string; message?: string }

/** Opt-in (`confirmScan: true`): turn an allowed scan into a prompt, because npx may fetch and run code from the network. */
export function confirmScan(evaluation: Evaluation): void {
  if (evaluation.effect !== "allow" || evaluation.action !== SCAN_TOOL) return
  evaluation.effect = "ask"
  evaluation.message = downloadQuestion(evaluation.resources)
}
