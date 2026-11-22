/**
 * The on-demand sweep's report. Pure: `lifecycle.ts` decides each lane through `finalize`'s checks and,
 * in prune mode, through `finalize` itself, the single removal path; this only shapes the answer.
 */

export type SweepMode = "report" | "prune"

export type SweepEntry = {
  child: string
  directory: string
  branch: string
  /** `remove`: the lane's worktree is (report) or was (prune) removable. `keep`: it stays, for `reason`. */
  verdict: "remove" | "keep"
  reason: string
  /** Kept with work that only a person can resolve (uncommitted, unmerged or denied). */
  needsPerson?: true
}

/** One entry per directory, sorted, so a second run over the same lanes gives the same plan. */
export function orderEntries(entries: readonly SweepEntry[]): SweepEntry[] {
  const seen = new Set<string>()
  const unique = entries.filter((entry) => !seen.has(entry.directory) && seen.add(entry.directory))
  return unique.sort((a, b) => a.directory.localeCompare(b.directory))
}

export function formatSweep(entries: readonly SweepEntry[], mode: SweepMode): string {
  if (entries.length === 0) return "subagent_worktree_sweep: no lanes to consider."
  const lines = entries.map((entry) => {
    const word = entry.verdict === "remove" ? (mode === "prune" ? "removed" : "would remove") : "keep"
    return `${word.padEnd(12)} ${entry.directory} (${entry.branch}): ${entry.reason}`
  })
  const attention = entries.filter((entry) => entry.needsPerson).length
  return [`subagent_worktree_sweep (${mode}):`, ...lines, attention > 0 ? `${attention} kept with work that needs a person.` : ""].filter(Boolean).join("\n")
}
