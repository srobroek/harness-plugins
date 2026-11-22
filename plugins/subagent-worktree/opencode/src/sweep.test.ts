import { describe, expect, test } from "bun:test"
import { formatSweep, orderEntries, type SweepEntry } from "./sweep.ts"

const entry = (over: Partial<SweepEntry> = {}): SweepEntry => ({
  child: "ses_a",
  directory: "/wt/a",
  branch: "a",
  verdict: "keep",
  reason: "the tree has uncommitted changes",
  ...over,
})

describe("orderEntries", () => {
  test("sorts by directory and keeps the first entry of a repeated one", () => {
    const ordered = orderEntries([entry({ directory: "/wt/b" }), entry({ directory: "/wt/a", reason: "first" }), entry({ directory: "/wt/a", reason: "second" })])
    expect(ordered.map((e) => [e.directory, e.reason])).toEqual([
      ["/wt/a", "first"],
      ["/wt/b", "the tree has uncommitted changes"],
    ])
  })
})

describe("formatSweep", () => {
  test("no lanes says so", () => {
    expect(formatSweep([], "report")).toBe("subagent_worktree_sweep: no lanes to consider.")
  })

  test("a removable lane reads would-remove in a report and removed after a prune", () => {
    const removable = [entry({ verdict: "remove", reason: "landed" })]
    expect(formatSweep(removable, "report")).toContain("would remove /wt/a (a): landed")
    expect(formatSweep(removable, "prune")).toContain("removed      /wt/a (a): landed")
  })

  test("kept lanes that need a person are counted", () => {
    const text = formatSweep([entry({ needsPerson: true }), entry({ directory: "/wt/b" })], "report")
    expect(text).toContain("1 kept with work that needs a person.")
  })
})
