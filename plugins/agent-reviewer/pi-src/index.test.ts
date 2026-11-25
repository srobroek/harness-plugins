import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import agentReviewer from "./index.ts"
import { COMMAND_REASON, prReviewerBlockReason, READ_REASON, skillDirectories } from "./pr-reviewer-gate.ts"

const SKILLS = "/pkgs/quality/skills"
const prompt = [
  '<active_agent name="pr-reviewer"/>',
  "",
  "<available_skills>",
  "  <skill>",
  "    <name>quality-code-design</name>",
  `    <location>${SKILLS}/quality-code-design/SKILL.md</location>`,
  "  </skill>",
  "  <skill>",
  "    <name>relative</name>",
  "    <location>skills/relative/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n")

const bash = (command: unknown) => prReviewerBlockReason({ toolName: "bash", input: { command } }, prompt, "/repo", "/home/u")
// The lexical cases use paths that do not exist, so they resolve each path to itself.
const read = (path: unknown, systemPrompt = prompt) =>
  prReviewerBlockReason({ toolName: "read", input: { path } }, systemPrompt, "/repo", "/home/u", (target) => target)

describe("pr-reviewer pi gate on the real file system", () => {
  test("compares canonical paths: a symlink out of a skill directory and an unresolvable path are refused", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-reviewer-gate-")))
    try {
      const skill = join(root, "skills", "quality-code-design")
      mkdirSync(skill, { recursive: true })
      writeFileSync(join(skill, "SKILL.md"), "# skill\n")
      writeFileSync(join(root, "secret.txt"), "secret\n")
      symlinkSync(join(root, "secret.txt"), join(skill, "escape.md"))
      const real = `<available_skills><skill><location>${skill}/SKILL.md</location></skill></available_skills>`
      const readReal = (path: string) => prReviewerBlockReason({ toolName: "read", input: { path } }, real, root, "/home/u")
      expect(readReal(join(skill, "SKILL.md"))).toBeUndefined()
      expect(readReal(join(skill, "escape.md"))).toBe(READ_REASON)
      expect(readReal(join(skill, "missing.md"))).toBe(READ_REASON)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("pr-reviewer pi gate", () => {
  test("allows exactly the two gh reads the prompt names", () => {
    expect(bash("gh pr view 183 --repo srobroek/harness-plugins --json title,body,files,headRefOid")).toBeUndefined()
    expect(bash("gh pr diff 183 --repo srobroek/harness-plugins")).toBeUndefined()
    expect(bash("  gh pr diff 7 --repo o/r.js  ")).toBeUndefined()
  })

  test("refuses any other command, and a gh read joined to another command", () => {
    for (const command of [
      "ls",
      "gh pr diff 183",
      "gh pr view 183 --repo o/r",
      "gh pr merge 183 --repo o/r",
      "gh api repos/o/r",
      "gh pr diff 183 --repo o/r; rm -rf .",
      "gh pr diff 183 --repo o/r && cat ~/.ssh/id_rsa",
      "gh pr diff 183 --repo o/r | sh",
      "gh pr diff 183 --repo o/r > /tmp/x",
      "gh pr diff $(id) --repo o/r",
      "gh pr diff 183 --repo o/`id`",
      "gh pr diff 183 --repo o/r\nrm -rf .",
      "gh pr view 1 --repo o/r --json title --jq .title",
      "gh pr diff 0 --repo o/r",
      undefined,
    ])
      expect({ command, reason: bash(command) }).toEqual({ command, reason: COMMAND_REASON })
  })

  test("allows reads inside a listed skill's directory only", () => {
    expect(read(`${SKILLS}/quality-code-design/SKILL.md`)).toBeUndefined()
    expect(read(`@${SKILLS}/quality-code-design/references/review.md`)).toBeUndefined()
    for (const path of [
      "README.md",
      "/repo/src/index.ts",
      "~/.ssh/id_rsa",
      `${SKILLS}/quality-code-design/../../../../etc/passwd`,
      `${SKILLS}/quality-code-design-evil/SKILL.md`,
      "/repo/skills/relative/SKILL.md",
      undefined,
    ])
      expect({ path, reason: read(path) }).toEqual({ path, reason: READ_REASON })
    expect(read(`${SKILLS}/quality-code-design/SKILL.md`, '<active_agent name="pr-reviewer"/>')).toBe(READ_REASON)
  })

  test("lists the absolute skill directories of the available-skills block", () => {
    expect(skillDirectories(prompt)).toEqual([`${SKILLS}/quality-code-design`])
    expect(skillDirectories(`<location>${SKILLS}/x/SKILL.md</location>`)).toEqual([])
  })

  test("leaves other tools to the agent's tools list", () => {
    expect(prReviewerBlockReason({ toolName: "contact_supervisor", input: {} }, prompt, "/repo")).toBeUndefined()
  })
})

describe("agent-reviewer pi extension", () => {
  type Handler = (event: { toolName: string; input: unknown }, ctx: unknown) => unknown
  const register = (sessionName: string | undefined) => {
    let handler: Handler | undefined
    agentReviewer({
      on: (event: string, fn: Handler) => {
        if (event === "tool_call") handler = fn
      },
      getSessionName: () => sessionName,
      registerTool: () => undefined,
    } as never)
    return handler as Handler
  }
  const ctx = (systemPrompt: string, parentSession?: string) => ({
    cwd: "/repo",
    getSystemPrompt: () => systemPrompt,
    sessionManager: { getHeader: () => ({ type: "session", id: "c", ...(parentSession ? { parentSession } : {}) }) },
  })

  test("blocks a pr-reviewer child's other command", () => {
    expect(register("pr-reviewer: review")({ toolName: "bash", input: { command: "cat .env" } }, ctx(prompt, "/p.jsonl"))).toEqual({
      block: true,
      reason: COMMAND_REASON,
    })
  })

  test("leaves the main session, other agents and an untagged child alone", () => {
    const call = { toolName: "bash", input: { command: "cat .env" } }
    expect(register("main")(call, ctx(prompt))).toBeUndefined()
    expect(register("code-reviewer")(call, ctx('<active_agent name="code-reviewer"/>', "/p.jsonl"))).toBeUndefined()
    // OMP may name a child session after its agent; only the pi-subagents tag engages the gate.
    expect(register("pr-reviewer")(call, ctx("plain prompt", "/p.jsonl"))).toBeUndefined()
  })
})
