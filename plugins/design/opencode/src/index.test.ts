import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type AgentPermission, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { createPlugin, SCAN_TOOL, SETUP_TOOL } from "./index.ts"

const SKILLS = [
  "accessibility-audit",
  "design-component-truth",
  "design-evidence",
  "design-guide",
  "design-md",
  "design-no-slop",
  "design-prototype",
  "design-system-audit",
  "design-token-discipline",
  "design-upstream-preflight",
  "motion-design",
  "ui-microcopy",
  "ui-review",
  "wireloom",
]

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>

const context = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

test("registers the design skills, the four design agents, both tools and no scan prompt", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(SKILLS)
  expect([...fake.agents.keys()].sort()).toEqual(["a11y-auditor", "design-critic", "ui-implementer", "ui-ux-specialist"])
  for (const agent of fake.agents.values()) expect(agent.mode).toBe("subagent")
  expect(fake.agents.get("ui-ux-specialist")?.permissions).toContainEqual({
    action: "subagent",
    resource: "design-critic",
    effect: "allow",
  })
  expect([...fake.tools.keys()]).toEqual([SETUP_TOOL, SCAN_TOOL])
  expect(fake.hooks("permission")).toEqual([])
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.tools.size).toBe(0)
})

test("confirmScan=true registers the prompt; an allowed scan asks and a deny stays a deny", async () => {
  const fake = createFakeContext({ options: { confirmScan: true } })
  await plugin.setup(fake.context)
  expect(fake.hooks("permission")).toEqual(["evaluate"])
  const scan = { action: SCAN_TOOL, resources: ["src"] }
  expect((await fake.fire.permission("evaluate", { ...scan, effect: "allow" })).effect).toBe("ask")
  expect((await fake.fire.permission("evaluate", { ...scan, effect: "deny" })).effect).toBe("deny")
})

test.each(["false", "true", 1, "yes"])("a non-boolean confirmScan %p registers no prompt and keeps an allow", async (value) => {
  const fake = createFakeContext({ options: { confirmScan: value } })
  await plugin.setup(fake.context)
  expect(fake.hooks("permission")).toEqual([])
  const evaluation = await fake.fire.permission("evaluate", { action: SCAN_TOOL, resources: ["src"], effect: "allow" })
  expect(evaluation.effect).toBe("allow")
})

test("without options an allowed scan stays allowed", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const evaluation = await fake.fire.permission("evaluate", { action: SCAN_TOOL, resources: ["src"], effect: "allow" })
  expect(evaluation.effect).toBe("allow")
})

test("every own references/ path in a design skill resolves; other skills' references exist too", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const skills = new Map([...fake.skills].map(([id, skill]) => [id, skill as unknown as { path: string; content: string }]))
  for (const skill of skills.values()) {
    for (const match of skill.content.matchAll(/(?:the `([\w-]+)` skill's )?`(references\/[\w.-]+\.md)`/g)) {
      const owner = match[1] ? skills.get(match[1]) : skill
      expect(owner).toBeDefined()
      expect(existsSync(join(dirname(owner?.path ?? ""), match[2] ?? ""))).toBe(true)
    }
  }
})

test("design_setup asks for the resolved workspace and copies the formulas", async () => {
  const repo = mkdtempSync(join(tmpdir(), "design-setup-"))
  try {
    mkdirSync(join(repo, ".beads"))
    const fake = createFakeContext({ directory: repo })
    await plugin.setup(fake.context)
    const setup = fake.tools.get(SETUP_TOOL)?.execute as Execute
    const result = await setup({}, context)
    expect(result.metadata.ok).toBe(true)
    expect(fake.asserts[0]).toMatchObject({ action: SETUP_TOOL, resources: [repo] })
    expect(existsSync(join(repo, ".beads", "formulas", "design-touch.formula.toml"))).toBe(true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("design_impeccable_scan asks before npx runs, and a rejection stops it", async () => {
  const seen: string[][] = []
  const exec = async (argv: string[]): Promise<SupervisedRun> => {
    seen.push(argv)
    return { kind: "exited", exitCode: 0, signalCode: null, stdout: "[]", stderr: "" }
  }
  const fake = createFakeContext({ directory: "/project" })
  await createPlugin({ exec }).setup(fake.context)
  const scan = fake.tools.get(SCAN_TOOL)?.execute as Execute
  const result = await scan({ targets: ["src", "https://example.test/"] }, context)
  expect(result.metadata).toMatchObject({ ok: true, status: "clean", findings: 0 })
  expect(fake.asserts[0]).toMatchObject({ action: SCAN_TOOL, resources: ["/project/src", "https://example.test/"] })
  expect(seen[0]).toEqual(["npx", "--yes", "impeccable", "detect", "--json", "/project/src", "https://example.test/"])

  const refused = createFakeContext({
    assert: () => {
      throw new Error("rejected")
    },
  })
  await createPlugin({ exec }).setup(refused.context)
  const blocked = refused.tools.get(SCAN_TOOL)?.execute as Execute
  await expect(blocked({ targets: ["src"] }, context)).rejects.toThrow("rejected")
  expect(seen).toHaveLength(1)
  expect((await blocked({ targets: [] }, context)).metadata.ok).toBe(false)
})

test("design MCP servers are opt-in in frontend projects", async () => {
  const shipped = JSON.parse(await Bun.file(new URL("../.mcp.json", import.meta.url)).text()).mcpServers
  const directory = mkdtempSync(join(tmpdir(), "design-mcp-"))
  try {
    await Bun.write(join(directory, "package.json"), '{"dependencies":{"react":"19"}}')

    const defaults = createFakeContext({ directory })
    await plugin.setup(defaults.context)
    expect(defaults.mcp.size).toBe(0)

    const enabled = createFakeContext({
      directory,
      options: { mcpServers: { "accessibility-scanner": true, "wire-dsl": true } },
    })
    const cleanup = await plugin.setup(enabled.context)
    expect([...enabled.mcp.keys()]).toEqual(["accessibility-scanner", "wire-dsl"])
    // npx runs outside the project, on the public registry: a project .npmrc (for example a
    // CodeArtifact registry with an expired token) must not break the design servers.
    for (const name of ["accessibility-scanner", "wire-dsl"]) {
      expect(enabled.mcp.get(name)).toMatchObject({
        cwd: process.env.HOME,
        environment: { npm_config_registry: "https://registry.npmjs.org/" },
      })
    }
    expect(enabled.mcp.get("wire-dsl")).toEqual({
      type: "local",
      command: [shipped["wire-dsl"].command, ...shipped["wire-dsl"].args],
      cwd: process.env.HOME,
      environment: { npm_config_registry: "https://registry.npmjs.org/" },
      codemode: true,
    })
    await cleanup?.()
    expect(enabled.mcp.size).toBe(0)

    const withStorybook = createFakeContext({ directory, options: { mcpServers: { storybook: true } } })
    await plugin.setup(withStorybook.context)
    expect(withStorybook.mcp.get("storybook")).toEqual({
      type: "remote",
      url: "http://localhost:6006/mcp",
      codemode: true,
      oauth: false,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("adds no servers outside a frontend project by default", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  expect(fake.mcp.size).toBe(0)
})

test("ui-implementer allows debug, defaults to Context7 and opts into AWS tools", async () => {
  const { permissions } = readAgentFile(join(import.meta.dir, "../agents/ui-implementer.md"))
  expect(permissionEffect(permissions, "subagent", "debug")).toBe("allow")
  for (const other of ["coder", "ui-ux-specialist", "explore"])
    expect(permissionEffect(permissions, "subagent", other)).toBe("deny")

  const defaults = createFakeContext()
  await plugin.setup(defaults.context)
  const defaultPermissions = (defaults.agents.get("ui-implementer")?.permissions ?? []) as AgentPermission[]
  expect(permissionEffect(defaultPermissions, "aws-mcp_search_documentation")).toBe("deny")

  const aws = createFakeContext({ options: { tools: ["context7_*", "aws-mcp_*"] } })
  await plugin.setup(aws.context)
  const awsPermissions = (aws.agents.get("ui-implementer")?.permissions ?? []) as AgentPermission[]
  expect(permissionEffect(awsPermissions, "context7_query-docs")).toBe("allow")
  expect(permissionEffect(awsPermissions, "aws-mcp_search_documentation")).toBe("allow")
})
