import { describe, expect, test } from "bun:test"
import type { Lane } from "./lane.ts"
import { decideRelease, type HandoverRepair, parseRelease, type Release, type ReleaseFacts, repairHandover } from "./release.ts"

/** A deleted child whose lane names the caller, in a clean, pushed worktree with no holds. */
const base: ReleaseFacts = {
  caller: "ses_parent",
  child: { state: "deleted", owner: "ses_parent" },
  holds: undefined,
  tree: { dirty: false, unpushed: 0 },
}

describe("decideRelease", () => {
  test("releases a deleted child that the caller spawned, in a clean, pushed worktree", () => {
    expect(decideRelease(base)).toEqual({ release: true })
  })

  test.each([
    ["an idle child", "idle"],
    ["a child whose last run never ended", "running"],
    ["an archived child", "archived"],
  ] as const)("refuses %s: only a deleted session proves its work has stopped", (_name, state) => {
    const decision = decideRelease({ ...base, child: { state, owner: "ses_parent" } })
    expect(decision.release === false && decision.reason).toMatch(/session still exists.*stop it and delete its session, then release again/)
  })

  test.each([
    ["an unreadable session", { child: { state: "unknown" as const } }, /cannot read session/],
    ["another session's child", { child: { state: "deleted" as const, owner: "ses_other" } }, /only the session that spawned/],
    ["a child with no known owner", { child: { state: "deleted" as const } }, /only the session that spawned/],
    ["work held on the worktree", { holds: "a delivery merge holds it" }, /work is still running on the worktree: a delivery merge holds it/],
    ["uncommitted changes", { tree: { dirty: true, unpushed: 0 } }, /uncommitted changes/],
    ["commits missing from the upstream", { tree: { dirty: false, unpushed: 2 } }, /2 commits not pushed/],
    ["no upstream", { tree: { dirty: false, unpushed: undefined } }, /no upstream/],
    ["an unreadable worktree", { tree: undefined }, /cannot read the worktree/],
  ] as const)("refuses %s", (_name, override, reason) => {
    const decision = decideRelease({ ...base, ...override } as ReleaseFacts)
    expect(decision.release).toBe(false)
    expect(decision.release === false && decision.reason).toMatch(reason)
  })
})

describe("repairHandover", () => {
  const old: Lane = { child: "ses_old", parent: "ses_parent", projectID: "prj", directory: "/wt/a", branch: "feat", base: "abc", parentDir: "/repo", state: "active" }
  const record: Release = { child: "ses_old", directory: "/wt/a", by: "ses_parent", at: 1, head: "abc", reason: "dead", to: "ses_new", toParent: "ses_lead" }

  test.each([
    ["no release record", undefined, undefined, old, { kind: "none" }],
    ["a record that names no successor", { ...record, to: undefined }, undefined, old, { kind: "none" }],
    ["a record of another writer", { ...record, child: "ses_other" }, undefined, old, { kind: "none" }],
    ["a successor whose lane is stored", record, { ...old, child: "ses_new" }, old, { kind: "drop-old" }],
    ["a successor whose lane is already retired", record, { ...old, child: "ses_new", state: "merged" as const }, old, { kind: "drop-old" }],
    ["an old lane that was being removed", record, undefined, { ...old, state: "removing" as const }, { kind: "hold" }],
    [
      "a successor with no lane yet",
      record,
      undefined,
      old,
      { kind: "complete", lane: { ...old, child: "ses_new", parent: "ses_lead", handedOver: { from: "ses_old", at: 9 } } },
    ],
    [
      "a record from before the successor's parent was recorded",
      { ...record, toParent: undefined },
      undefined,
      old,
      { kind: "complete", lane: { ...old, child: "ses_new", handedOver: { from: "ses_old", at: 9 } } },
    ],
  ] as const)("%s", (_name, given, successor, lane, expected) => {
    expect(repairHandover(lane as Lane, given as Release | undefined, successor as Lane | undefined, 9)).toEqual(expected as HandoverRepair)
  })
})

describe("parseRelease", () => {
  const record = { child: "ses_a", directory: "/wt/a", by: "ses_parent", at: 1, head: "abc", reason: "dead" }

  test("reads a release record and rejects a malformed one", () => {
    expect(parseRelease(record)).toEqual(record)
    expect(parseRelease({ ...record, to: "ses_b" })).toEqual({ ...record, to: "ses_b" })
    expect(parseRelease({ ...record, directory: "" })).toBeUndefined()
    expect(parseRelease("release")).toBeUndefined()
  })
})
