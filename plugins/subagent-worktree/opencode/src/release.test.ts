import { describe, expect, test } from "bun:test"
import { decideRelease, hasOpenToolCall, parseRelease, type ReleaseFacts } from "./release.ts"

const MINUTE = 60_000
const QUIET = 10 * MINUTE
const NOW = 100 * MINUTE

/** A child that last ran an hour ago and finished, owned by the caller, in a clean, pushed worktree. */
const base: ReleaseFacts = {
  caller: "ses_parent",
  child: { state: "idle", owner: "ses_parent", busy: NOW - 60 * MINUTE, idle: NOW - 59 * MINUTE },
  openTool: false,
  tree: { dirty: false, unpushed: 0 },
  now: NOW,
  quietMs: QUIET,
}

describe("decideRelease", () => {
  test.each([
    ["an idle child", {}, false],
    ["an archived child", { child: { state: "archived" as const, owner: "ses_parent" } }, false],
    ["a deleted child whose lane names the caller", { child: { state: "deleted" as const, owner: "ses_parent" }, openTool: undefined }, false],
    ["a child whose last run never ended, quiet for the bound", { child: { state: "running" as const, owner: "ses_parent", busy: NOW - QUIET } }, true],
    ["an open tool call, quiet past the bound", { openTool: true }, true],
  ] as const)("releases %s", (_name, override, interrupt) => {
    expect(decideRelease({ ...base, ...override })).toEqual({ release: true, interrupt })
  })

  test.each([
    ["a child that is running now", { child: { state: "running" as const, owner: "ses_parent", busy: NOW - MINUTE } }, /still running/],
    ["a recent open tool call", { child: { ...base.child, idle: NOW - MINUTE }, openTool: true }, /still running/],
    ["a recent update of a run that never ended", { child: { state: "running" as const, owner: "ses_parent", busy: NOW - QUIET - 1, updated: NOW - 1 } }, /still running/],
    ["unreadable tool calls", { openTool: undefined }, /cannot read the tool calls/],
    ["an unreadable session", { child: { state: "unknown" as const } }, /cannot read session/],
    ["another session's child", { child: { ...base.child, owner: "ses_other" } }, /only the session that spawned/],
    ["a child with no known owner", { child: { state: "deleted" as const }, openTool: undefined }, /only the session that spawned/],
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

describe("hasOpenToolCall", () => {
  const assistant = (status: string) => ({ type: "assistant", content: [{ type: "text", text: "x" }, { type: "tool", id: "t", name: "bash", state: { status } }] })

  test.each([
    ["a running tool call", [assistant("completed"), assistant("running")], true],
    ["a streaming tool call", [assistant("streaming")], true],
    ["only finished tool calls", [assistant("completed"), assistant("error")], false],
    ["no messages", [], false],
    ["a transcript that is not a list", { data: [] }, undefined],
  ])("%s", (_name, messages, expected) => {
    expect(hasOpenToolCall(messages)).toBe(expected)
  })
})

describe("parseRelease", () => {
  const record = { child: "ses_a", directory: "/wt/a", by: "ses_parent", at: 1, head: "abc", reason: "dead", interrupted: false }

  test("reads a release record and rejects a malformed one", () => {
    expect(parseRelease(record)).toEqual(record)
    expect(parseRelease({ ...record, directory: "" })).toBeUndefined()
    expect(parseRelease("release")).toBeUndefined()
  })
})
