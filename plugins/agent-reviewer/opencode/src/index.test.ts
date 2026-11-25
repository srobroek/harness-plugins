import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { type AgentFile, type AgentPermission, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { fragmentParts, readFragment } from "@srobroek/opencode-lib/fragments"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { AGENTS_DIR, REVIEWERS } from "./index.ts"

const files = new Map<string, AgentFile>(REVIEWERS.map((id) => [id, readAgentFile(join(AGENTS_DIR, `${id}.md`))]))
const file = (id: string) => files.get(id) as AgentFile
const core = [...fragmentParts("review-core", readFragment("review-core")).values()]

type Fake = ReturnType<typeof createFakeContext>
const rules = (fake: Fake, id: string) => fake.agents.get(id)?.permissions as AgentPermission[]

describe("agent-reviewer", () => {
  test("registers the four reviewers on the reviewer tier and the hidden skill, and disposes them", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.agents.keys()].sort()).toEqual([...REVIEWERS])
    for (const id of REVIEWERS) {
      expect(fake.agents.get(id)).toMatchObject({ mode: "subagent", request: { headers: { "x-opencode-model-role": "reviewer" } } })
      expect(fake.agents.get(id)?.model).toBeUndefined()
    }
    expect(fake.skills.get("review-security")).toMatchObject({ autoinvoke: false })
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("only pr-reviewer is hidden; the others stay in the subagent catalog", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    expect(fake.agents.get("pr-reviewer")?.hidden).toBe(true)
    for (const id of ["code-reviewer", "security-auditor", "adversarial-challenger"]) expect(fake.agents.get(id)?.hidden).toBeUndefined()
  })

  test("every reviewer composes the whole review core and names its verdict line", () => {
    for (const id of REVIEWERS) {
      for (const part of core) expect(file(id).system).toContain(part)
      expect(file(id).system).not.toContain("{{include")
      expect(file(id).system).toMatch(/First line: `VERDICT: [A-Z|-]+ --/)
    }
  })

  test("no reviewer can edit, spawn, ask the user, run Code Mode or load any skill not named", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    for (const id of REVIEWERS) {
      for (const action of ["edit", "write", "subagent", "question", "execute", "some_plugin_tool"])
        expect(permissionEffect(rules(fake, id), action)).toBe("deny")
      expect(permissionEffect(rules(fake, id), "skill", "any-skill")).toBe("deny")
    }
  })

  test("pr-reviewer permits forge-specific reads only", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const pr = rules(fake, "pr-reviewer")
    for (const command of [
      "gh pr view 7 --repo o/r --json title",
      "gh pr diff 7 --repo o/r",
      "glab mr view 7 --repo o/r --output json",
      "glab mr diff 7 --repo o/r",
      "glab api projects/o%2Fr/merge_requests/7 -X GET",
      "glab api projects/o%2Fr/merge_requests/7 --method GET",
    ]) expect(permissionEffect(pr, "shell", command)).toBe("allow")
    for (const command of ["gh api repos/o/r", "glab api projects/o%2Fr/merge_requests/7 -X POST", "glab api projects/o%2Fr/merge_requests/7 --method POST", "git diff", "cat x"])
      expect(permissionEffect(pr, "shell", command)).toBe("deny")
    for (const action of ["read", "grep", "webfetch"]) expect(permissionEffect(pr, action)).toBe("deny")
    for (const skill of ["quality-code-design", "lang-rust", "review-security"]) expect(permissionEffect(pr, "skill", skill)).toBe("allow")
  })

  test("code-reviewer has the read-only shell: inspection and fetches run, mutations do not", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const code = rules(fake, "code-reviewer")
    for (const command of ["git diff main...HEAD", "git log --oneline -5", "git status", "git fetch origin pull/7/head", "gh pr diff 1", "gh pr view 1"])
      expect(permissionEffect(code, "shell", command)).toBe("allow")
    for (const command of ["git diff --output=x", "git log -p --output x", "git commit -m x", "rm -rf .", "gh pr merge 1", "bd close bd-1"])
      expect(permissionEffect(code, "shell", command)).toBe("deny")
    for (const action of ["read", "grep", "glob", "lsp_diagnostics"]) expect(permissionEffect(code, action)).toBe("allow")
    for (const action of ["webfetch", "websearch"]) expect(permissionEffect(code, action)).toBe("deny")
    expect(permissionEffect(code, "skill", "ast-grep-search")).toBe("allow")
    expect(permissionEffect(code, "skill", "lang-rust")).toBe("allow")
    expect(permissionEffect(code, "skill", "delivery-git-workflow")).toBe("allow")
  })

  test("security-auditor reads code with a read-only shell and no web", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const security = rules(fake, "security-auditor")
    for (const action of ["read", "grep", "glob", "lsp_hover"]) expect(permissionEffect(security, action)).toBe("allow")
    for (const action of ["webfetch", "websearch"]) expect(permissionEffect(security, action)).toBe("deny")
    expect(permissionEffect(security, "shell", "git log -3")).toBe("allow")
    expect(permissionEffect(security, "shell", "git push")).toBe("deny")
    expect(permissionEffect(security, "skill", "review-security")).toBe("allow")
    for (const skill of ["quality-code-design", "lang-rust"]) expect(permissionEffect(security, "skill", skill)).toBe("allow")
    expect(permissionEffect(security, "skill", "ast-grep-search")).toBe("allow")
    expect(permissionEffect(security, "read", ".env")).toBe("ask")
    expect(file("security-auditor").system).toContain("CWE id")
    expect(file("security-auditor").system).toContain("VERDICT: PASS|MINOR|MAJOR")
  })

  test("adversarial-challenger keeps web reads for cited sources and a read-only shell", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const challenger = rules(fake, "adversarial-challenger")
    for (const action of ["read", "grep", "glob", "lsp_hover", "webfetch", "websearch"])
      expect(permissionEffect(challenger, action)).toBe("allow")
    expect(permissionEffect(challenger, "shell", "git log -3")).toBe("allow")
    expect(permissionEffect(challenger, "shell", "git push")).toBe("deny")
  })
})

