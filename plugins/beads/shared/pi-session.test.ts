import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  actorCovers,
  headerView,
  isSubagentChild,
  piActor,
  readSessionHeader,
  type SessionHeaderView,
  sessionLineage,
} from "./pi-session.ts"

const root = mkdtempSync(join(tmpdir(), "pi-session-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("readSessionHeader", () => {
  test("reads the first line of a session file", () => {
    const file = join(root, "a.jsonl")
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "s-1", parentSession: "/p.jsonl" })}\n{"type":"message"}\n`)
    expect(readSessionHeader(file)).toEqual({ id: "s-1", parentSession: "/p.jsonl" })
  })

  test("a missing file, a non-header first line or a directory is no header", () => {
    const other = join(root, "b.jsonl")
    writeFileSync(other, '{"type":"message","id":"m"}\n')
    expect(readSessionHeader(join(root, "missing.jsonl"))).toBeUndefined()
    expect(readSessionHeader(other)).toBeUndefined()
    expect(readSessionHeader(root)).toBeUndefined()
  })

  test("an empty parentSession is dropped", () => {
    expect(headerView({ type: "session", id: "x", parentSession: "" })).toEqual({ id: "x" })
  })
})

describe("sessionLineage", () => {
  const headers: Record<string, SessionHeaderView> = {
    "/s/root.jsonl": { id: "root" },
    "/s/root/child.jsonl": { id: "child", parentSession: "/s/root.jsonl" },
  }
  const read = (file: string) => headers[file]

  test("walks parentSession up to the root", () => {
    expect(sessionLineage({ id: "grandchild", parentSession: "/s/root/child.jsonl" }, read)).toEqual([
      "root",
      "child",
      "grandchild",
    ])
  })

  test("a root session is its own lineage", () => {
    expect(sessionLineage({ id: "root" }, read)).toEqual(["root"])
  })

  test("an unreadable parent ends the walk there", () => {
    expect(sessionLineage({ id: "x", parentSession: "/gone.jsonl" }, read)).toEqual(["x"])
  })

  test("a cycle or an unsafe id ends the walk", () => {
    const loop: Record<string, SessionHeaderView> = {
      "/a": { id: "a", parentSession: "/b" },
      "/b": { id: "b", parentSession: "/a" },
      "/bad": { id: "evil'; rm", parentSession: "/a" },
    }
    expect(sessionLineage({ id: "a", parentSession: "/b" }, (file) => loop[file])).toEqual(["b", "a"])
    expect(sessionLineage({ id: "c", parentSession: "/bad" }, (file) => loop[file])).toEqual(["c"])
  })
})

describe("piActor", () => {
  test("joins the lineage under pi/", () => {
    expect(piActor(["root", "child"])).toBe("pi/root/child")
  })

  test("an unsafe own id is made safe", () => {
    expect(piActor(["a b'c"])).toBe("pi/a_b_c")
  })
})

describe("actorCovers", () => {
  test("covers the actor itself and its descendants only", () => {
    expect(actorCovers("pi/r", "pi/r")).toBe(true)
    expect(actorCovers("pi/r", "pi/r/c")).toBe(true)
    expect(actorCovers("pi/r/c", "pi/r")).toBe(false)
    expect(actorCovers("pi/r", "pi/rr")).toBe(false)
    expect(actorCovers("pi/r", "sjors")).toBe(false)
  })
})

describe("isSubagentChild", () => {
  test("a detached runner marks every session it hosts", () => {
    expect(isSubagentChild({ env: { PI_SUBAGENT_CHILD: "1" } })).toBe(true)
  })

  test("a root session is not a child", () => {
    expect(isSubagentChild({ env: {}, sessionFile: "/s/root.jsonl" })).toBe(false)
  })

  test("a foreground child lives under its parent's session directory", () => {
    expect(
      isSubagentChild({ env: {}, parentSession: "/s/2026_root.jsonl", sessionFile: "/s/2026_root/run-1/child.jsonl" }),
    ).toBe(true)
  })

  test("a /fork or /clone sits beside the original and is the user's own session", () => {
    expect(isSubagentChild({ env: {}, parentSession: "/s/2026_root.jsonl", sessionFile: "/s/2026_fork.jsonl" })).toBe(false)
  })

  test("a child without a session file is a child", () => {
    expect(isSubagentChild({ env: {}, parentSession: "/s/2026_root.jsonl" })).toBe(true)
  })
})
