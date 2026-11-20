import { describe, expect, test } from "bun:test"
import { childFrom, readBeads, sessionBusy } from "./gather.ts"
import type { Run } from "./rundir.ts"

describe("sessionBusy", () => {
  test.each([
    ["never ran", {}, false],
    ["first execution running", { busy: 100 }, true],
    ["running again after an earlier end", { busy: 300, idle: 200 }, true],
    ["finished", { busy: 100, idle: 200 }, false],
  ])("%s", (_name, time, expected) => {
    expect(sessionBusy({ time })).toBe(expected)
  })
})

describe("childFrom", () => {
  const info = { id: "ses_c", title: "lane a", agent: "coder", time: { updated: 5_000, busy: 4_000 } }

  test("takes busy state and agent from the session, and the newest activity it knows", () => {
    expect(childFrom(info, 9_000, 1_000)).toEqual({ sessionID: "ses_c", title: "lane a", agent: "coder", busy: true, lastActivity: 9_000 })
  })

  test("after a restart, falls back to the session's own update time", () => {
    expect(childFrom(info, undefined, 1_000).lastActivity).toBe(5_000)
  })

  test("never reports activity before the run was armed", () => {
    expect(childFrom(info, undefined, 7_000).lastActivity).toBe(7_000)
  })
})

test("readBeads parses bd JSON after a warning line and keeps the fields a tick reads", async () => {
  const outputs: Record<string, string> = {
    list: `warning: something\n${JSON.stringify([
      { id: "p-1", status: "open", issue_type: "epic", description: "long" },
      { id: "p-1.1", status: "in_progress", parent: "p-1", labels: ["human"] },
      { status: "open" },
    ])}`,
    ready: JSON.stringify([{ id: "p-1.1" }]),
    blocked: "[]",
  }
  const run: Run = async (_cwd, _command, args) => ({ ok: true, stdout: outputs[args[0] as string] ?? "", stderr: "" })
  expect(await readBeads("/repo", run)).toEqual({
    ok: true,
    beads: [
      { id: "p-1", status: "open", parent: null, issue_type: "epic", labels: null },
      { id: "p-1.1", status: "in_progress", parent: "p-1", labels: ["human"] },
    ],
    ready: ["p-1.1"],
    blocked: [],
  })
})

test.each(["list", "ready", "blocked"])("readBeads reports a failed bd %s as an incomplete read", async (failing) => {
  const run: Run = async (_cwd, _command, args) => ({ ok: args[0] !== failing, stdout: "[]", stderr: "" })
  expect((await readBeads("/repo", run)).ok).toBe(false)
})
