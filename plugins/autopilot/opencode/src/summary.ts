/** Summary rendering for a stopped run. Pure. */

import type { JournalEntry } from "./journal.ts"
import type { RunState } from "./state.ts"

/** The label of the bead a stopped run leaves behind. */
export const HANDOFF_LABEL = "autopilot-handoff"

const line = (entry: JournalEntry) => {
  const tags = [entry.bead, entry.lane].filter(Boolean).join(", ")
  const evidence = entry.evidence ? ` (${entry.evidence})` : ""
  const chosen = entry.chosen ? ` → ${entry.chosen}` : ""
  return `- ${tags ? `[${tags}] ` : ""}${entry.summary}${chosen}${evidence}`
}

const section = (title: string, entries: readonly string[]) => (entries.length ? [`## ${title}`, "", ...entries, ""] : [])

/** `summary.md`: changed, decided, needs input, blocked, parked. */
export function renderSummary(state: RunState, journal: readonly JournalEntry[], runPath: string): string {
  const of = (type: JournalEntry["type"]) => journal.filter((entry) => entry.type === type)
  const blockers = of("blocker")
  const needsInput = [...blockers.filter((entry) => entry.parked), ...of("ambiguity")]
  return [
    `# Autopilot run ${state.runId}`,
    "",
    `- Scope: ${state.scope.kind === "bead" ? state.scope.id : state.scope.kind === "goal" ? state.scope.text : "bd ready queue"}`,
    `- Stopped: ${state.stopReason ?? "unknown"}`,
    `- Ticks: ${state.ticks}; closed beads: ${state.beads.closed.length}; open: ${state.beads.open.length}`,
    `- Run directory: ${runPath}`,
    "",
    ...section("Changed", [...of("progress"), ...of("action")].map(line)),
    ...section("Decided", of("decision").map(line)),
    ...section("Needs input", needsInput.map(line)),
    ...section("Blocked", blockers.filter((entry) => !entry.parked).map(line)),
    ...section("Parked", state.parked.map((item) => `- ${item}`)),
    ...section("Issues", of("issue").map(line)),
  ].join("\n")
}

/** The text of the handoff bead's description. */
export function handoffDescription(state: RunState, journal: readonly JournalEntry[], runPath: string): string {
  const items = [...journal.filter((entry) => entry.type === "blocker" && entry.parked), ...journal.filter((entry) => entry.type === "ambiguity")]
  return [
    `Autopilot run ${state.runId} stopped: ${state.stopReason ?? "unknown"}.`,
    `Run directory: ${runPath} (summary.md, journal.jsonl).`,
    `Review with: /autopilot review ${state.runId}`,
    "",
    items.length ? "Needs input:" : "Nothing needs input.",
    ...items.map(line),
  ].join("\n")
}
