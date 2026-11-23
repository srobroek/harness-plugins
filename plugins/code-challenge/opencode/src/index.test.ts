import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type AgentPermission, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { COMMAND, challengePrompt, LIB_FACTS_TOOL, parseInvocation, SCAN_TOOL, SETUP_TOOL, VALIDATE_TOOL } from "./index.ts"

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>

const context = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

test("registers the skill, both agents, the setup tool and the command, and removes them on cleanup", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["code-challenge"])
  expect([...fake.agents.keys()].sort()).toEqual(["code-challenger", "refactor-challenger"])
  expect([...fake.tools.keys()]).toEqual([SETUP_TOOL, LIB_FACTS_TOOL, VALIDATE_TOOL, SCAN_TOOL])
  expect([...fake.commands.keys()]).toEqual([COMMAND])
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.tools.size).toBe(0)
  expect(fake.commands.size).toBe(0)
})

test("challenge_lib_facts registered by setup validates its input before any request", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const lookup = fake.tools.get(LIB_FACTS_TOOL)?.execute as Execute
  const result = await lookup({ ecosystem: "gem", packages: [{ name: "x" }] }, context)
  expect(result.metadata.ok).toBe(false)
  expect(result.content).toContain("ecosystem must be one of npm, pypi, crates, go")
})

test("challenge_scan registered by setup rejects bad input before any process starts", async () => {
  const fake = createFakeContext({ sessions: [{ id: "ses_1", location: { directory: tmpdir() } }] })
  await plugin.setup(fake.context)
  const scan = fake.tools.get(SCAN_TOOL)?.execute as Execute
  for (const input of [{ depth: "bottomless" }, { lenses: ["hand-rolled-lib"] }, { languages: ["cobol"] }]) {
    const result = await scan(input, context)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("challenge_scan:")
  }
  expect(fake.asserts).toEqual([])
})

test("challenge_scan accepts the canonical hand-rolled-library lens", async () => {
  const repo = mkdtempSync(join(tmpdir(), "challenge-scan-lens-"))
  try {
    const fake = createFakeContext({ sessions: [{ id: "ses_1", location: { directory: repo } }] })
    await plugin.setup(fake.context)
    const scan = fake.tools.get(SCAN_TOOL)?.execute as Execute
    const result = await scan({ lenses: ["hand-rolled-library"], staticOnly: true }, context)
    expect(result.metadata.ok).toBe(true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("challenge_scan resolves a default and a relative root against the session directory, not the plugin's", async () => {
  const plugin_dir = mkdtempSync(join(tmpdir(), "challenge-scan-plugin-"))
  const session_dir = realpathSync(mkdtempSync(join(tmpdir(), "challenge-scan-session-")))
  try {
    mkdirSync(join(session_dir, "sub"))
    const fake = createFakeContext({ directory: plugin_dir, sessions: [{ id: "ses_1", location: { directory: session_dir } }] })
    await plugin.setup(fake.context)
    const scan = fake.tools.get(SCAN_TOOL)?.execute as Execute
    const roots = await Promise.all([{}, { root: "sub" }].map((input) => scan({ ...input, staticOnly: true }, context)))
    expect(roots.map((r) => (JSON.parse(r.content) as { root: string }).root)).toEqual([session_dir, join(session_dir, "sub")])
  } finally {
    rmSync(plugin_dir, { recursive: true, force: true })
    rmSync(session_dir, { recursive: true, force: true })
  }
})

test("challenge_scan fails closed when the session cannot be read", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const scan = fake.tools.get(SCAN_TOOL)?.execute as Execute
  const error = await scan({ staticOnly: true }, context).then(
    () => undefined,
    (caught: unknown) => caught as Error,
  )
  expect(error?.message).toContain("challenge_scan: cannot read session ses_1")
  expect((error?.cause as Error | undefined)?.message).toContain("no session ses_1")
})

test("both challengers are read-only subagents that cannot edit, change the repository or spawn agents", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  for (const id of ["code-challenger", "refactor-challenger"]) {
    const agent = fake.agents.get(id)
    expect(agent?.mode).toBe("subagent")
    const rules = (agent?.permissions ?? []) as AgentPermission[]
    for (const action of ["edit", "write", "subagent", "challenge_setup"])
      expect(permissionEffect(rules, action, "*")).not.toBe("allow")
    expect(permissionEffect(rules, "shell", "git log -3")).toBe("allow")
    expect(permissionEffect(rules, "shell", "git push")).toBe("deny")
    expect(permissionEffect(rules, "challenge_scan", "*")).toBe("allow")
    expect(permissionEffect(rules, "challenge_lib_facts", "*")).toBe("allow")
  }
})

test("both challengers may read exactly the skill's own references directory without a prompt, and nothing else outside the project", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const skill = fake.skills.get("code-challenge") as unknown as { path: string }
  const references = join(dirname(skill.path), "references")
  for (const id of ["code-challenger", "refactor-challenger"]) {
    const rules = (fake.agents.get(id)?.permissions ?? []) as AgentPermission[]
    expect(permissionEffect(rules, "external_directory", join(references, "lens-stability.md"))).toBe("allow")
    expect(permissionEffect(rules, "external_directory", join(references, "evidence.md"))).toBe("allow")
    // The grant is the references directory: its parent (SKILL.md, formulas), a sibling skill and the project are not covered.
    expect(permissionEffect(rules, "external_directory", skill.path)).toBe("ask")
    expect(permissionEffect(rules, "external_directory", join(dirname(dirname(references)), "other", "references", "x.md"))).toBe("ask")
    expect(permissionEffect(rules, "external_directory", "/etc/passwd")).toBe("ask")
  }
})

test("every references/ file the skill links exists beside it", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const skill = fake.skills.get("code-challenge") as unknown as { path: string; content: string }
  const links = [...skill.content.matchAll(/\]\((references\/[\w.-]+)\)/g)].map((match) => match[1] ?? "")
  expect(links.length).toBeGreaterThan(12)
  for (const link of links) expect(existsSync(join(dirname(skill.path), link))).toBe(true)
})

test("challenge_setup asks for the resolved workspace and copies the formulas", async () => {
  const repo = mkdtempSync(join(tmpdir(), "challenge-setup-"))
  try {
    mkdirSync(join(repo, ".beads"))
    const fake = createFakeContext({ directory: repo, sessions: [{ id: "ses_1", location: { directory: repo } }] })
    await plugin.setup(fake.context)
    const setup = fake.tools.get(SETUP_TOOL)?.execute as Execute
    const result = await setup({}, context)
    expect(result.metadata.ok).toBe(true)
    expect(fake.asserts[0]).toMatchObject({ action: SETUP_TOOL, resources: [repo] })
    expect(existsSync(join(repo, ".beads", "formulas", "code-challenge.formula.toml"))).toBe(true)
    expect((await setup({ workspace: "" }, context)).metadata.ok).toBe(false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("parseInvocation reads auto and a depth only at the front, in either order", () => {
  expect(parseInvocation("")).toEqual({ autonomous: false, depth: undefined, target: "" })
  expect(parseInvocation("auto")).toEqual({ autonomous: true, depth: undefined, target: "" })
  expect(parseInvocation("  AUTO deep plugins/lib ")).toEqual({ autonomous: true, depth: "deep", target: "plugins/lib" })
  expect(parseInvocation("quick auto src")).toEqual({ autonomous: true, depth: "quick", target: "src" })
  expect(parseInvocation("src auto deep")).toEqual({ autonomous: false, depth: undefined, target: "src auto deep" })
})

test("challengePrompt loads the skill and states the mode, depth and target", () => {
  const prompt = challengePrompt("auto deep plugins/lib")
  expect(prompt).toContain("`code-challenge` skill")
  expect(prompt).toContain("Mode: autonomous")
  expect(prompt).toContain("Depth: deep.")
  expect(prompt).toContain("Target: plugins/lib")
  const bare = challengePrompt("")
  expect(bare).toContain("Mode: interactive.")
  expect(bare).toContain("Depth: not given")
  expect(bare).toContain("Target: not given")
})

test("/code-challenge submits the prompt in the invoking session", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  const command = fake.commands.get(COMMAND)
  expect(command?.name).toBe("code-challenge")
  await command?.execute({ sessionID: "ses_1", prompt: { text: "auto src" }, delivery: "queue" } as never)
  const call = fake.calls.find((entry) => entry.method === "session.prompt")
  const input = call?.input as { sessionID: string; text: string; delivery: string }
  expect(input.sessionID).toBe("ses_1")
  expect(input.text).toContain("Mode: autonomous")
  expect(input.text).toContain("Target: src")
  expect(input.delivery).toBe("queue")
  await cleanup?.()
})

test("the agents name the tiers the design gives them", async () => {
  const root = join(import.meta.dir, "..", "..", "common", "agents")
  const role = (id: string) =>
    (readAgentFile(join(root, `${id}.md`)) as unknown as { request?: { headers?: Record<string, string> } }).request?.headers?.[
      "x-opencode-model-role"
    ]
  expect(role("code-challenger")).toBe("reviewer")
  expect(role("refactor-challenger")).toBe("reviewer")
})

test("challenge_setup fails closed when the session cannot be read, and writes nothing", async () => {
  const repo = mkdtempSync(join(tmpdir(), "challenge-setup-"))
  try {
    mkdirSync(join(repo, ".beads"))
    // The plugin's base directory is the repo, but session ses_1 is unknown to the host.
    const fake = createFakeContext({ directory: repo })
    await plugin.setup(fake.context)
    const setup = fake.tools.get(SETUP_TOOL)?.execute as Execute
    const error = await setup({}, context).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    )
    expect(error?.message).toContain("cannot read session ses_1")
    expect((error?.cause as Error | undefined)?.message).toContain("no session ses_1")
    expect(fake.asserts).toHaveLength(0)
    expect(existsSync(join(repo, ".beads", "formulas"))).toBe(false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
