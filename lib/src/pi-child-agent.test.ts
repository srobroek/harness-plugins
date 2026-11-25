import { describe, expect, test } from "bun:test"
import { isPiChildAgent } from "./pi-child-agent.ts"

describe("isPiChildAgent", () => {
  test("matches the active-agent tag or the session name in a child session only", () => {
    expect(isPiChildAgent("pr-reviewer", '<active_agent name="pr-reviewer"/>\n\nReview.', "worker: x", true)).toBe(true)
    expect(isPiChildAgent("pr-reviewer", "<active_agent name='pr-reviewer' />", undefined, true)).toBe(true)
    expect(isPiChildAgent("pr-reviewer", "plain", "pr-reviewer", true)).toBe(true)
    expect(isPiChildAgent("pr-reviewer", "plain", "pr-reviewer: review 12", true)).toBe(true)
    expect(isPiChildAgent("pr-reviewer", '<active_agent name="pr-reviewer"/>', "pr-reviewer", false)).toBe(false)
  })

  test("does not match another agent or a name that only starts the same", () => {
    expect(isPiChildAgent("pr-reviewer", '<active_agent name="code-reviewer"/>', "code-reviewer", true)).toBe(false)
    expect(isPiChildAgent("pr-reviewer", '<active_agent name="pr-reviewer-2"/>', "pr-reviewer-2", true)).toBe(false)
    expect(isPiChildAgent("a.b", '<active_agent name="axb"/>', undefined, true)).toBe(false)
  })
})
