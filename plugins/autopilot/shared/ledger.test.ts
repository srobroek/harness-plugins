import { describe, expect, test } from "bun:test"
import type { BoundedRead } from "@srobroek/opencode-lib/bounded-read"
import { followRedirect, foreignBead, type LedgerHost, parseRoutes, resolveLedger } from "./ledger.ts"

const SESSION = "/town/rig/.beads"
const OTHER = "/town/other/.beads"

const text = (value: string | undefined): BoundedRead => (value === undefined ? { kind: "absent" } : { kind: "text", text: value })

const host = (over: Partial<LedgerHost> & { ledgers?: string[]; routes?: string; redirects?: Record<string, string>; routesOf?: Record<string, string> } = {}): LedgerHost => ({
  sessionLedger: () => SESSION,
  isLedger: (path) => (over.ledgers ?? [SESSION, OTHER]).includes(path),
  canonical: (path) => path,
  readRoutes: (ledger) => text(over.routesOf?.[ledger] ?? over.routes),
  readRedirect: (ledger) => text(over.redirects?.[ledger]),
  ...over,
})

// Route rules follow bd's docs/multi-agent/routing.md (gastownhall/beads), "Looking up a bead in
// another store by prefix".
describe("parseRoutes", () => {
  test("keeps entries whose prefix ends in a hyphen and drops junk and hyphenless prefixes", () => {
    const text = ['{"prefix":"gt-","path":"mayor/rig"}', "not json", '{"prefix":"hq","path":"."}', '{"prefix":5}', '{"prefix":"x-","path":""}', ""].join("\n")
    expect([...parseRoutes(text)]).toEqual([["gt-", "mayor/rig"]])
  })
})

describe("followRedirect", () => {
  const redirected = (content: string) => followRedirect(SESSION, host({ redirects: { [SESSION]: content } }))

  test("follows the first line that is no comment, relative to the directory holding the .beads", () => {
    expect(redirected("# moved\n\n../other/.beads\n")).toEqual({ ok: true, ledger: OTHER })
  })

  test("follows an absolute target", () => {
    expect(redirected(OTHER)).toEqual({ ok: true, ledger: OTHER })
  })

  test("stays put with no redirect, an empty one, or a target that is no ledger", () => {
    expect(followRedirect(SESSION, host())).toEqual({ ok: true, ledger: SESSION })
    expect(redirected("# nothing\n")).toEqual({ ok: true, ledger: SESSION })
    expect(redirected("../gone/.beads")).toEqual({ ok: true, ledger: SESSION })
  })

  test("follows one level only", () => {
    expect(followRedirect(SESSION, host({ redirects: { [SESSION]: "../other/.beads", [OTHER]: "../rig/.beads" } }))).toEqual({ ok: true, ledger: OTHER })
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

  test("the longest matching prefix wins over a shorter one", () => {
    const routes = ['{"prefix":"hq-","path":"../rig"}', '{"prefix":"hq-cv-","path":"../other"}'].join("\n")
    expect(resolveLedger({ scope: { kind: "bead", id: "hq-cv-sub-1" }, directory: "/town/rig" }, host({ routes }))).toEqual({ ok: true, ledger: OTHER })
    expect(resolveLedger({ scope: { kind: "bead", id: "hq-2" }, directory: "/town/rig" }, host({ routes }))).toEqual({ ok: true, ledger: SESSION })
  })

  test("a route whose prefix lacks the trailing hyphen matches nothing", () => {
    expect(resolveLedger({ scope: { kind: "bead", id: "oth-1" }, directory: "/town/rig" }, host({ routes: '{"prefix":"oth","path":"../other"}' }))).toEqual({ ok: true, ledger: SESSION })
  })

  test("a prefix is matched on the id, not on a stem derived from it", () => {
    const routes = '{"prefix":"oth-sub-","path":"../other"}'
    expect(resolveLedger({ scope: { kind: "bead", id: "oth-sub-x-1" }, directory: "/town/rig" }, host({ routes }))).toEqual({ ok: true, ledger: OTHER })
  })

  test("routes are read from the redirect's target, not the redirecting ledger", () => {
    const redirects = { [SESSION]: "../other/.beads" }
    const routesOf = { [SESSION]: '{"prefix":"p-","path":"../third"}', [OTHER]: '{"prefix":"p-","path":"."}' }
    expect(resolveLedger({ scope: { kind: "bead", id: "p-1" }, directory: "/town/rig" }, host({ redirects, routesOf }))).toEqual({ ok: true, ledger: OTHER })
  })

  test("a routed target that redirects is followed", () => {
    const third = "/town/third/.beads"
    const result = resolveLedger(
      { scope: { kind: "bead", id: "oth-1" }, directory: "/town/rig" },
      host({ ledgers: [SESSION, OTHER, third], routes: '{"prefix":"oth-","path":"../other"}', redirects: { [OTHER]: "../third/.beads" } }),
    )
    expect(result).toEqual({ ok: true, ledger: third })
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
    expect(foreignBead(SESSION, "oth-1", host({ routes: '{"prefix":"oth","path":"../other"}' }))).toBeUndefined()
    expect(foreignBead(SESSION, "rig-1", host({ routes: '{"prefix":"rig-","path":"."}' }))).toBeUndefined()
  })
})
