import { describe, expect, test } from "bun:test"
import { canonicalCheckout, sessionRunning } from "./session-eviction.ts"

describe("pure helpers", () => {
  test("sessionRunning: busy after idle, or busy with no idle", () => {
    expect(sessionRunning({ time: { busy: 5, idle: 2 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 5 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 1, idle: 2 } })).toBe(false)
    expect(sessionRunning({})).toBe(false)
  })

  test("an archived session counts as idle, whatever its times say", () => {
    expect(sessionRunning({ time: { busy: 9, idle: 2, archived: 3 } })).toBe(false)
  })

  test("canonicalCheckout: the parent of .git, else the fallback", () => {
    expect(canonicalCheckout("/repo/.git", "/fallback")).toBe("/repo")
    expect(canonicalCheckout("/store/repo.git", "/fallback")).toBe("/fallback")
    expect(canonicalCheckout(undefined, "/fallback")).toBe("/fallback")
  })
})
