import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { ANALYZE_REDIRECT, IMPLEMENT_REDIRECT, IMPLEMENT_ROUTE, MARKER, type SkillRouting } from "../opencode/src/skills.ts"
import {
  guardInput,
  guardReason,
  inputRoute,
  readCommand,
  routedCommand,
  routedRead,
  tasksToIssuesReason,
  toolPath,
} from "./routes.ts"

const ALL: SkillRouting = { implement: true, analyze: true, taskstoissues: true }
const NONE: SkillRouting = { implement: false, analyze: false, taskstoissues: false }
const REFUSAL = tasksToIssuesReason("/agent/settings.json")

describe("routedCommand", () => {
  test("reads prompt templates and skill commands with their arguments", () => {
    expect(routedCommand("/speckit.implement")).toEqual({ id: "speckit.implement", args: "" })
    expect(routedCommand("  /speckit.implement  only T003\nand T004 ")).toEqual({
      id: "speckit.implement",
      args: "only T003\nand T004",
    })
    expect(routedCommand("/skill:speckit-analyze")).toEqual({ id: "speckit-analyze", args: "" })
    expect(routedCommand("/speckit.github.taskstoissues")).toEqual({ id: "speckit.github.taskstoissues", args: "" })
  })

  test("ignores commands no route applies to and plain text", () => {
    expect(routedCommand("/speckit.plan")).toBeUndefined()
    expect(routedCommand("/speckit.implementation")).toBeUndefined()
    expect(routedCommand("run /speckit.implement")).toBeUndefined()
    expect(routedCommand("/skill:other")).toBeUndefined()
  })
})

describe("inputRoute", () => {
  test("implement becomes the beads route, keeping the user's words", () => {
    expect(inputRoute({ id: "speckit.implement", args: "" }, ALL, REFUSAL)).toEqual({ kind: "transform", text: IMPLEMENT_ROUTE })
    const route = inputRoute({ id: "speckit-implement", args: "T003 only" }, ALL, REFUSAL)
    expect(route).toEqual({ kind: "transform", text: `${IMPLEMENT_ROUTE}\n\nUser input: T003 only` })
    // The route is no command, so pi expands nothing after the transform.
    expect(IMPLEMENT_ROUTE.startsWith("/")).toBe(false)
  })

  test("taskstoissues is refused and analyze runs with the note", () => {
    expect(inputRoute({ id: "speckit.taskstoissues", args: "" }, ALL, REFUSAL)).toEqual({ kind: "refuse", reason: REFUSAL })
    expect(inputRoute({ id: "speckit.analyze", args: "x" }, ALL, REFUSAL)).toEqual({ kind: "analyze" })
  })

  test("routes switched off leave the command as upstream wrote it", () => {
    for (const id of ["speckit.implement", "speckit.analyze", "speckit.taskstoissues"])
      expect(inputRoute({ id, args: "" }, NONE, REFUSAL)).toBeUndefined()
  })
})

describe("readCommand", () => {
  test("names the routed prompt templates and skill files", () => {
    expect(readCommand("/repo/.pi/prompts/speckit.implement.md")).toBe("speckit.implement")
    expect(readCommand(`${homedir()}/.pi/agent/prompts/speckit.taskstoissues.md`)).toBe("speckit.taskstoissues")
    expect(readCommand("/repo/.agents/skills/speckit-analyze/SKILL.md")).toBe("speckit-analyze")
    expect(readCommand("C:\\repo\\.pi\\prompts\\speckit.implement.md")).toBe("speckit.implement")
  })

  test("leaves other files alone", () => {
    expect(readCommand("/repo/.pi/prompts/speckit.plan.md")).toBeUndefined()
    expect(readCommand("/repo/.agents/skills/speckit-implement/references/x.md")).toBeUndefined()
    expect(readCommand("/repo/specs/001-a/speckit.implement.md")).toBeUndefined()
  })
})

describe("routedRead", () => {
  test("replaces implement, prefixes analyze and leaves its own output alone", () => {
    expect(routedRead("speckit.implement", "upstream", ALL, REFUSAL)).toBe(IMPLEMENT_REDIRECT)
    expect(routedRead("speckit-analyze", "upstream", ALL, REFUSAL)).toBe(`${ANALYZE_REDIRECT}\nupstream`)
    expect(routedRead("speckit.taskstoissues", "upstream", ALL, REFUSAL)).toBe(`${MARKER}\n${REFUSAL}\n`)
    expect(routedRead("speckit.implement", IMPLEMENT_REDIRECT, ALL, REFUSAL)).toBeUndefined()
    expect(routedRead("speckit.implement", "upstream", NONE, REFUSAL)).toBeUndefined()
  })
})

describe("paths", () => {
  test("toolPath resolves as pi's file tools do", () => {
    expect(toolPath("@specs/001-a/tasks.md", "/repo")).toBe("/repo/specs/001-a/tasks.md")
    expect(toolPath("~/x/tasks.md", "/repo")).toBe(`${homedir()}/x/tasks.md`)
    expect(toolPath("/abs/tasks.md", "/repo")).toBe("/abs/tasks.md")
  })

  test("guardInput rewrites only a string path", () => {
    expect(guardInput({ path: "@specs/001-a/tasks.md", content: "x" }, "/repo")).toEqual({
      path: "/repo/specs/001-a/tasks.md",
      content: "x",
    })
    const bash = { command: "echo x > specs/001-a/tasks.md" }
    expect(guardInput(bash, "/repo")).toBe(bash)
    expect(guardInput(null, "/repo")).toBeNull()
  })
})

test("pi's refusals name the settings key that switches them off", () => {
  expect(guardReason("/agent/settings.json")).toEndWith('Disable: set "tasksGuard": false under the "speckit-beads" key of /agent/settings.json')
  expect(REFUSAL).toEndWith('Disable: set "blockTasksToIssues": false under the "speckit-beads" key of /agent/settings.json')
  expect(REFUSAL).not.toContain("plugin option")
})
