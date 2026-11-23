import { describe, expect, test } from "bun:test"
import * as piTui from "@earendil-works/pi-tui"
import type { Question } from "../shared/questions.ts"
import { type Round, view } from "../shared/rounds.ts"
import { keyName, newPanelState, type PanelState, ParleyPanel, panelHints, surfaceFrom, type TuiKit } from "./panel.ts"
import { PiParley } from "./session.ts"

/** Raw terminal input, as pi hands it to `handleInput`. */
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  ctrlS: "\x13",
  space: " ",
} as const

const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const kit: TuiKit = piTui

const db: Question = {
  id: "db",
  title: "Database",
  kind: "pick_one",
  options: [
    { id: "sqlite", label: "SQLite", description: "embedded" },
    { id: "pg", label: "Postgres" },
  ],
  recommended: "sqlite",
  rationale: "No server to run",
}
const checks: Question = { id: "checks", title: "CI checks", kind: "pick_many", options: [{ id: "lint", label: "Lint" }, { id: "test", label: "Test" }, { id: "e2e", label: "E2E" }] }
const name: Question = { id: "name", title: "Service name", kind: "ask_text" }
const replicas: Question = { id: "replicas", title: "Replicas", kind: "slider", min: 1, max: 5, recommended: 2 }

/** A round opened through `PiParley`, its panel, and a key driver: no pi, no model. */
async function open(questions: Question[], state: PanelState = newPanelState()) {
  const rounds: Round[] = []
  const events: string[] = []
  const parley = new PiParley({
    sessionID: "s",
    directory: "/repo",
    persist: () => {},
    deliver: () => {},
    present: (round) => rounds.push(round),
    closed: ({ round }) => events.push(`closed:${round.status}`),
  })
  const asked = parley.ask({ questions }, { ui: true })
  await tick()
  const round = rounds[0] as Round
  let renders = 0
  const panel = new ParleyPanel(
    kit,
    { requestRender: () => renders++, terminal: { rows: 40 } },
    plain,
    {
      round: () => {
        const live = parley.rounds.get(round.id)
        return live?.status === "open" ? view(live) : undefined
      },
      submit: (answers) => parley.submit(round.id, answers),
      dismiss: () => parley.dismiss(round.id),
      minimise: () => events.push("minimise"),
      readFiles: () => [],
      findPaths: () => [],
      now: Date.now,
    },
    state,
  )
  const press = (...keys: string[]) => {
    for (const key of keys) panel.handleInput(key)
  }
  const type = (text: string) => press(...text)
  const screen = (width = 80) => panel.render(width).join("\n")
  return { parley, panel, asked, press, type, screen, events, renders: () => renders }
}

describe("ParleyPanel keyboard", () => {
  test("answers a mixed round: recommendation, toggles, note, free text and a number", async () => {
    const { asked, press, type, screen } = await open([db, checks, name, replicas])
    expect(screen()).toContain("Parley round 1")
    expect(screen()).toContain("★ Recommended: SQLite")
    expect(screen()).toContain("Why: No server to run")
    expect(screen()).toContain("› (•) 1. SQLite ★  embedded")

    press(KEY.tab, "1", "2", "n")
    type("why not e2e?")
    press(KEY.enter)
    expect(screen()).toContain("[x] 1. Lint")
    expect(screen()).toContain("Note: why not e2e?")

    press(KEY.tab, "e")
    type("reports")
    press(KEY.enter, KEY.tab, KEY.right, KEY.right)
    expect(screen()).toContain("4")

    press(KEY.ctrlS)
    const { result } = await asked
    expect(result.status).toBe("submitted")
    expect(result.answers).toEqual([
      { id: "db", status: "accepted", value: { selected: "sqlite" }, accepted_recommendation: true },
      { id: "checks", status: "answered", value: { selected: ["lint", "test"] }, accepted_recommendation: false, note: "why not e2e?" },
      { id: "name", status: "answered", value: { text: "reports" }, accepted_recommendation: false },
      { id: "replicas", status: "answered", value: { value: 4 }, accepted_recommendation: false },
    ])
  })

  test("moves the choice, defers and leaves untouched questions pending", async () => {
    const { asked, press, screen } = await open([db, name])
    press(KEY.down, KEY.space)
    expect(screen()).toContain("› (•) 2. Postgres")
    press("j", "d")
    expect(screen()).toContain("⏸ deferred")
    press(KEY.shiftTab, KEY.ctrlS)
    const { result } = await asked
    expect(result.answers.map((answer) => [answer.id, answer.status, answer.value])).toEqual([
      ["db", "answered", { selected: "pg" }],
      ["name", "deferred", undefined],
    ])
  })

  test("enter on a one-question round with nothing picked takes the row under the cursor", async () => {
    const ship: Question = { id: "ship", title: "Ship it?", kind: "confirm" }
    const { asked, press } = await open([ship])
    press(KEY.down, KEY.enter)
    expect((await asked).result.answers[0]).toMatchObject({ id: "ship", status: "answered", value: { choice: "no" } })
  })

  test("a one-question round submits on enter and takes free text with e", async () => {
    const { asked, press, type } = await open([db])
    press("e")
    type("DuckDB")
    press(KEY.enter, KEY.enter)
    expect((await asked).result.answers[0]).toMatchObject({ status: "answered", value: { other: "DuckDB" } })
  })

  test("shows the round's problems and stays open when a value is rejected", async () => {
    const { press, type, screen, parley } = await open([replicas, name])
    press("e")
    type("9")
    press(KEY.enter)
    expect(screen()).toContain("! Enter a number from 1 to 5")
    expect(parley.current()).toBeDefined()
  })

  test("D asks before it dismisses; another key keeps the round", async () => {
    const { asked, press, screen, parley } = await open([db, name])
    press("D")
    expect(screen()).toContain("Dismiss this round?")
    press("n")
    expect(parley.current()).toBeDefined()
    press("D", "y")
    expect((await asked).result).toMatchObject({ status: "cancelled", reason: "user_closed" })
  })

  test("esc minimises and the edits survive in the panel state", async () => {
    const state = newPanelState()
    const first = await open([db, checks], state)
    first.press(KEY.tab, "3", KEY.escape)
    expect(first.events).toContain("minimise")
    expect(state.focus).toBe(1)
    expect(state.drafts.get("checks")?.value).toEqual({ selected: ["e2e"] })
  })

  test("hides a conditional question until the answer it waits on matches", async () => {
    const gate: Question = { id: "cache", title: "Add a cache?", kind: "confirm" }
    const ttl: Question = { id: "ttl", title: "Cache TTL", kind: "slider", min: 0, max: 60, show_if: { id: "cache", equals: { choice: "yes" } } }
    const { press, screen } = await open([gate, ttl])
    expect(screen()).not.toContain("Cache TTL")
    press(KEY.space)
    expect(screen()).toContain("Q2 Cache TTL")
  })

  test("every rendered line fits the width", async () => {
    const long: Question = { ...db, body: "A ".repeat(200), options: [{ id: "a", label: "x".repeat(120) }, { id: "b", label: "B" }], recommended: "a" }
    const { panel } = await open([long, name])
    for (const width of [20, 50, 120]) for (const line of panel.render(width)) expect(piTui.visibleWidth(line)).toBeLessThanOrEqual(width)
  })
})

test("keyName names shifted letters like the panel's bindings", () => {
  expect(keyName(kit.parseKey, "D")).toBe("shift+d")
  expect(keyName(kit.parseKey, "\x13")).toBe("ctrl+s")
  expect(keyName(kit.parseKey, "j")).toBe("j")
})

describe("panel surface", () => {
  const request = (gone: boolean[]) => ({
    host: { round: () => undefined, submit: () => [], dismiss: () => {}, readFiles: () => [], findPaths: () => [], now: Date.now },
    state: newPanelState(),
    label: "Parley round 1",
    onGone: (shown: boolean) => gone.push(shown),
  })

  test("needs every pi-tui member the panel uses", () => {
    expect(surfaceFrom(undefined)).toBeUndefined()
    expect(surfaceFrom({ Editor: piTui.Editor, parseKey: piTui.parseKey })).toBeUndefined()
    expect(surfaceFrom(piTui)).toBeDefined()
  })

  test("cannot open without ctx.ui.custom, or when custom shows nothing", async () => {
    const surface = surfaceFrom(piTui)
    const gone: boolean[] = []
    expect(surface?.open({}, request(gone))).toBeUndefined()
    expect(surface?.open({ custom: () => undefined }, request(gone))).toBeUndefined()
    expect(surface?.open({ custom: () => Promise.resolve(undefined) }, request(gone))).toBeDefined()
    await tick()
    expect(gone).toEqual([false])
  })

  test("reports a built panel gone once it closes", async () => {
    const gone: boolean[] = []
    const ui = {
      custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: undefined) => void) => unknown) =>
        new Promise((resolve) => factory({ requestRender: () => {}, terminal: { rows: 40 } }, plain, {}, resolve)),
    }
    const open = surfaceFrom(piTui)?.open(ui, request(gone))
    await tick()
    expect(gone).toEqual([])
    open?.close()
    await tick()
    expect(gone).toEqual([true])
  })
})

test("panelHints lists only keys the pi panel binds", () => {
  const file: Question = { id: "f", title: "File", kind: "ask_file" }
  expect(panelHints(file, false)).toBe("e type paths (tab completes) · tab/j/k question · a accept · n note · d defer · ctrl+s submit · esc minimise · D dismiss")
  expect(panelHints(db, true)).toContain("enter submit")
  expect(panelHints(name, false, { field: "text", enterSaves: true, suggestions: false })).toBe("enter save · shift+enter newline · esc done · ctrl+s submit")
})
