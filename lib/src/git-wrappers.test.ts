import { describe, expect, test } from "bun:test"
import { DEFAULT_GIT_WRAPPERS, gitWrapperPattern, isGitCommand, readGitWrappers } from "./git-wrappers.ts"

describe("readGitWrappers", () => {
  test("defaults to only git when the option is absent or unusable", () => {
    expect(DEFAULT_GIT_WRAPPERS).toEqual(["git"])
    expect(readGitWrappers(undefined)).toEqual(["git"])
    expect(readGitWrappers({})).toEqual(["git"])
    expect(readGitWrappers({ gitWrappers: "dgit" })).toEqual(["git"])
    expect(readGitWrappers({ gitWrappers: [] })).toEqual(["git"])
    expect(readGitWrappers({ gitWrappers: [1, "", null] })).toEqual(["git"])
  })

  test("keeps the string entries of a list, in order", () => {
    expect(readGitWrappers({ gitWrappers: ["git", "dgit"] })).toEqual(["git", "dgit"])
    expect(readGitWrappers({ gitWrappers: ["dgit", 3, ""] })).toEqual(["dgit"])
  })
})

describe("isGitCommand", () => {
  test("matches only git by default, by basename", () => {
    expect(isGitCommand("git")).toBe(true)
    expect(isGitCommand("/usr/bin/git")).toBe(true)
    expect(isGitCommand("dgit")).toBe(false)
    expect(isGitCommand("gitk")).toBe(false)
    expect(isGitCommand("")).toBe(false)
    expect(isGitCommand(undefined)).toBe(false)
  })

  test("matches every listed wrapper", () => {
    const wrappers = ["git", "dgit"]
    expect(isGitCommand("dgit", wrappers)).toBe(true)
    expect(isGitCommand("/opt/bin/dgit", wrappers)).toBe(true)
    expect(isGitCommand("git", wrappers)).toBe(true)
    expect(isGitCommand("hub", wrappers)).toBe(false)
    expect(isGitCommand("git", ["dgit"])).toBe(false)
  })
})

describe("gitWrapperPattern", () => {
  test("is an alternation of the names, matched literally", () => {
    expect(gitWrapperPattern()).toBe("git")
    expect(gitWrapperPattern(["git", "dgit"])).toBe("git|dgit")
    const pattern = new RegExp(`^(?:${gitWrapperPattern(["git", "g.it+"])})$`)
    expect(pattern.test("g.it+")).toBe(true)
    expect(pattern.test("gxitt")).toBe(false)
  })
})
