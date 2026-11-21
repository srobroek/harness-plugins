import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type AgentPermission, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { COMMAND, challengePrompt, LIB_FACTS_TOOL, parseInvocation, SETUP_TOOL, VALIDATE_TOOL } from "./index.ts"

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>

const context = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

test("registers the skill, both agents, the setup tool and the command, and removes them on cleanup", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["code-challenge"])
  expect([...fake.agents.keys()].sort()).toEqual(["code-challenger", "refactor-challenger"])
  expect([...fake.tools.keys()]).toEqual([SETUP_TOOL, LIB_FACTS_TOOL, VALIDATE_TOOL])
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

test("both challengers are read-only subagents that cannot edit, run a shell or spawn agents", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  for (const id of ["code-challenger", "refactor-challenger"]) {
    const agent = fake.agents.get(id)
    expect(agent?.mode).toBe("subagent")
    const rules = (agent?.permissions ?? []) as AgentPermission[]
    for (const action of ["edit", "write", "shell", "subagent", "challenge_setup"])
      expect(permissionEffect(rules, action, "*")).not.toBe("allow")
    expect(permissionEffect(rules, "challenge_scan", "*")).toBe("allow")
    expect(permissionEffect(rules, "challenge_lib_facts", "*")).toBe("allow")
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
  expect(role("code-challenger")).toBe("standard")
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
