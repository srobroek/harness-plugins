import { describe, expect, test } from "bun:test"
import { classifyScope, deadlineAt, missingFields, parseDuration, parseInvocation } from "./args.ts"

describe("parseInvocation", () => {
  test("parses scope and every flag", () => {
    expect(parseInvocation('opencode-plugins-nbp --full --allow merge,deploy --lanes 5 --for 1h30m --until "PR open"')).toEqual({
      kind: "start",
      options: { scope: "opencode-plugins-nbp", full: true, allow: ["merge", "deploy"], lanes: 5, forMs: 5_400_000, until: "PR open" },
      missing: [],
    })
  })

  test("lists the setup fields left out", () => {
    expect(parseInvocation("")).toEqual({ kind: "start", options: {}, missing: ["scope", "full", "allow", "lanes", "budget", "until"] })
  })

  test("--allow self-review is a grant", () => {
  expect(parseInvocation("p-1 --allow self-review")).toMatchObject({ options: { allow: ["self-review"] } })
})

test("--no-full and --allow none answer those questions with no", () => {
    expect(parseInvocation('p-1 --no-full --allow none --lanes 2 --for 1h --until ""')).toMatchObject({ options: { full: false, allow: [] }, missing: [] })
  })

  test("joins free-text scope words", () => {
    const parsed = parseInvocation("fix the flaky tests --until-time 18:00")
    expect(parsed).toMatchObject({ kind: "start", options: { scope: "fix the flaky tests", untilTime: "18:00" } })
  })

  test.each([
    ["--lanes 0", "--lanes needs a whole number of at least 1"],
    ["--allow push", "--allow: unknown grant push; known: merge, deploy, self-review"],
    ["--for soon", "--for needs a duration such as 3h or 90m"],
    ["--for 1h --until-time 18:00", "use --for or --until-time, not both"],
    ["--bogus", "unknown flag --bogus"],
    ["stop now", "/autopilot stop takes no arguments"],
  ])("rejects %s", (text, message) => {
    expect(parseInvocation(text)).toEqual({ kind: "error", message })
  })

  test("parses the subcommands", () => {
    expect(parseInvocation("stop")).toEqual({ kind: "stop" })
    expect(parseInvocation("resume")).toEqual({ kind: "resume" })
    expect(parseInvocation("review 20261120-1400-abcd")).toEqual({ kind: "review", runId: "20261120-1400-abcd" })
  })
})

test("parseDuration rejects junk and sums units", () => {
  expect(parseDuration("2h15m")).toBe(8_100_000)
  expect(parseDuration("15")).toBeUndefined()
  expect(parseDuration("0m")).toBeUndefined()
})

test("deadlineAt rolls to tomorrow when the time has passed", () => {
  const now = new Date(2026, 10, 20, 19, 0).getTime()
  expect(deadlineAt("18:00", now)).toBe(new Date(2026, 10, 21, 18, 0).getTime())
  expect(deadlineAt("20:30", now)).toBe(new Date(2026, 10, 20, 20, 30).getTime())
})

test("missingFields treats either budget flag as answered", () => {
  expect(missingFields({ scope: "x", full: false, allow: [], lanes: 3, untilTime: "18:00", until: "" })).toEqual([])
})

test.each([
  [undefined, { kind: "queue" }],
  ["opencode-plugins-nbp.2", { kind: "bead", id: "opencode-plugins-nbp.2" }],
  ["ship the docs", { kind: "goal", text: "ship the docs" }],
])("classifyScope(%p)", (scope, expected) => {
  expect(classifyScope(scope)).toEqual(expected as never)
})
