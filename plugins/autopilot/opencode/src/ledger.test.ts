import { describe, expect, test } from "bun:test"
import { beadPrefix, foreignBead, type LedgerHost, parseRoutes, resolveLedger } from "./ledger.ts"

const SESSION = "/town/rig/.beads"
const OTHER = "/town/other/.beads"

const host = (over: Partial<LedgerHost> & { ledgers?: string[]; routes?: string } = {}): LedgerHost => ({
  sessionLedger: () => SESSION,
  isLedger: (path) => (over.ledgers ?? [SESSION, OTHER]).includes(path),
  canonical: (path) => path,
  readRoutes: () => over.routes,
  ...over,
})

describe("beadPrefix", () => {
  test.each([
    ["opencode-plugins-74r", "opencode-plugins"],
    ["p-1", "p"],
    ["p-1.2.3", "p"],
    ["nodash", undefined],
    ["", undefined],
  ])("%p -> %p", (id, prefix) => expect(beadPrefix(id)).toBe(prefix))
})

describe("parseRoutes", () => {
  test("reads prefix/path lines, with or without the trailing dash, and skips junk", () => {
    const text = ['{"prefix":"gt-","path":"mayor/rig"}', "not json", '{"prefix":"hq","path":"."}', '{"prefix":5}', ""].join("\n")
    expect([...parseRoutes(text)]).toEqual([
      ["gt", "mayor/rig"],
      ["hq", "."],
    ])
  })
})

describe("resolveLedger", () => {
  const queue = { kind: "queue" } as const

  test("an explicit ledger wins, resolved against the session directory", () => {
    expect(resolveLedger({ explicit: "../other/.beads", scope: queue, directory: "/town/rig" }, host())).toEqual({ ok: true, ledger: OTHER })
  })

  test("an explicit checkout directory resolves to its .beads", () => {
    expect(resolveLedger({ explicit: "../other", scope: queue, directory: "/town/rig" }, host())).toEqual({ ok: true, ledger: OTHER })
  })

  test("an explicit path that is no ledger is refused", () => {
    expect(resolveLedger({ explicit: "/nowhere", scope: queue, directory: "/town/rig" }, host())).toMatchObject({ ok: false })
  })

  test("a queue or goal scope uses the session directory's ledger", () => {
    expect(resolveLedger({ scope: queue, directory: "/town/rig" }, host())).toEqual({ ok: true, ledger: SESSION })
    expect(resolveLedger({ scope: { kind: "goal", text: "x" }, directory: "/town/rig" }, host())).toEqual({ ok: true, ledger: SESSION })
  })

  test("a bead id whose prefix is routed picks the routed ledger", () => {
    const routes = '{"prefix":"oth-","path":"../other"}\n'
    expect(resolveLedger({ scope: { kind: "bead", id: "oth-9x.2" }, directory: "/town/rig" }, host({ routes }))).toEqual({ ok: true, ledger: OTHER })
  })

  test("a bead id with no route uses the session ledger", () => {
    expect(resolveLedger({ scope: { kind: "bead", id: "p-1" }, directory: "/town/rig" }, host({ routes: '{"prefix":"oth-","path":"../other"}' }))).toEqual({ ok: true, ledger: SESSION })
  })

  test("a route to a directory that is no ledger is refused, not guessed around", () => {
    const routes = '{"prefix":"gone-","path":"../gone"}'
    expect(resolveLedger({ scope: { kind: "bead", id: "gone-1" }, directory: "/town/rig" }, host({ routes }))).toMatchObject({ ok: false })
  })

  test("with no explicit ledger and no ledger for the directory the arm is refused", () => {
    expect(resolveLedger({ scope: queue, directory: "/town/rig" }, host({ sessionLedger: () => undefined }))).toMatchObject({ ok: false })
  })
})

describe("foreignBead", () => {
  test("a bead whose prefix routes to another ledger is foreign", () => {
    expect(foreignBead(SESSION, "oth-1", host({ routes: '{"prefix":"oth-","path":"../other"}' }))).toContain(OTHER)
  })

  test("a bead with no route, or routed to this ledger, is the run's", () => {
    expect(foreignBead(SESSION, "p-1", host())).toBeUndefined()
    expect(foreignBead(SESSION, "rig-1", host({ routes: '{"prefix":"rig-","path":"."}' }))).toBeUndefined()
  })
})
