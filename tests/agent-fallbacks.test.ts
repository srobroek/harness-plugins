import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { type AgentFile, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { DEFAULT_MCP_TOOLS, toolRules } from "@srobroek/opencode-lib/agent-tools"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import codeResearcher, { CODE_RESEARCHER, AGENTS_DIR as CODE_RESEARCHER_DIR } from "../plugins/agent-researcher/opencode/src/index.ts"
import plugin, { AGENTS_DIR, REVIEWERS } from "../plugins/agent-reviewer/opencode/src/index.ts"
import { decideRouting } from "../plugins/beads/opencode/src/subagent-routing.ts"
import { loadAgents } from "../plugins/delivery/opencode/src/agents.ts"
import delivery from "../plugins/delivery/opencode/src/index.ts"
import { parseVerdict } from "../plugins/delivery/opencode/src/verdict.ts"
import quality from "../plugins/quality/opencode/src/index.ts"

// Plugins that ship the same agent as another plugin's fallback copy (delivery's code-researcher and pr-reviewer,
// quality's adversarial-challenger), and the consumers of agent-reviewer's and agent-researcher's prompts
// (delivery's verdict parser, the beads routing gate). These span plugins, so they live here and not in a plugin.

const files = new Map<string, AgentFile>(REVIEWERS.map((id) => [id, readAgentFile(join(AGENTS_DIR, `${id}.md`))]))
const file = (id: string) => files.get(id) as AgentFile
const codeResearcherFile = readAgentFile(join(CODE_RESEARCHER_DIR, `${CODE_RESEARCHER}.md`))

type Fake = ReturnType<typeof createFakeContext>
const withPlugins = (fake: Fake, plugins: unknown[]) => {
  ;(fake.context as unknown as Record<string, unknown>).plugin = { list: async () => ({ data: plugins }) }
  return fake
}

describe("agent-reviewer and delivery", () => {
  test("delivery parses the pr-reviewer and code-reviewer verdict lines", () => {
    expect(parseVerdict("VERDICT: REQUEST-CHANGES -- a.ts:3 drops the error", "pr-reviewer")).toMatchObject({
      verdict: "REQUEST-CHANGES",
    })
    expect(file("pr-reviewer").system).toContain("`VERDICT: APPROVE|REQUEST-CHANGES|COMMENT --")
    expect(file("code-reviewer").system).toContain("`VERDICT: APPROVE|REQUEST-CHANGES|COMMENT --")
  })
})

type Fallback = { id: string; owner: { setup: typeof delivery.setup }; ownerName: string }
const FALLBACKS: Fallback[] = [
  { id: "pr-reviewer", owner: delivery, ownerName: "srobroek.delivery" },
  { id: "adversarial-challenger", owner: quality, ownerName: "srobroek.quality" },
]

/** The file's rules plus the default MCP allow rules every agent but pr-reviewer gains. */
const expectedRules = (id: string) =>
  id === "pr-reviewer" ? file(id).permissions : [...file(id).permissions, ...toolRules(DEFAULT_MCP_TOOLS)]

describe.each(FALLBACKS)("$ownerName fallback $id", ({ id, owner, ownerName }) => {
  const expectOne = (fake: Fake) => {
    const agent = fake.agents.get(id) as Record<string, unknown>
    expect(agent.system).toBe(file(id).system)
    expect(agent.permissions).toEqual(expectedRules(id))
    expect(agent.model).toBeUndefined()
    expect(agent.request).toEqual(file(id).request)
    expect(agent.hidden).toBe(file(id).hidden)
  }

  test("the fallback copy alone registers the agent with the same prompt", async () => {
    const fake = createFakeContext()
    await owner.setup(fake.context)
    expect(fake.agents.get(id)?.system).toBe(file(id).system)
    expect(fake.agents.get(id)?.permissions).toEqual(expectedRules(id))
  })

  test("agent-reviewer then the fallback: the fallback leaves the agent alone", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    await owner.setup(fake.context)
    expectOne(fake)
    expect(fake.agentUpdates.filter((update) => update === id)).toHaveLength(1)
  })

  test("the fallback then agent-reviewer, reported by plugin.list: the fallback skips its copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: ownerName }, { id: "srobroek.agent-reviewer" }])
    await owner.setup(fake.context)
    expect(fake.agents.has(id)).toBe(false)
    await plugin.setup(fake.context)
    expectOne(fake)
  })

  test("the fallback then agent-reviewer, unseen by plugin.list: agent-reviewer replaces the copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: ownerName }])
    ;(fake.context as unknown as Record<string, unknown>).model = {
      list: async () => ({
        data: [{ providerID: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5", variants: [{ id: "high" }] }],
      }),
    }
    await owner.setup(fake.context)
    expect(fake.agents.has(id)).toBe(true)
    const copy = fake.agents.get(id) as { request?: { headers?: Record<string, string> } } | undefined
    if (id === "pr-reviewer") expect(copy?.request?.headers?.["x-opencode-model-fallback"]).toBeDefined()
    await plugin.setup(fake.context)
    expectOne(fake)
  })
})

test("delivery's pr-reviewer copy differs from the owner's only by its fallback model", () => {
  const copy = loadAgents(["pr-reviewer"])[0]
  const own = file("pr-reviewer")
  expect(copy?.model).toBe("amazon-bedrock/global.anthropic.claude-opus-5-5#high")
  expect(copy?.description).toBe(own.description)
  expect(copy?.system).toBe(own.system)
  expect(copy?.permissions).toEqual(own.permissions)
  expect(copy?.request).toEqual(own.request)
  expect(copy?.hidden).toBe(true)
})

test("quality's challenger copy is the owner's file", () => {
  const copy = readAgentFile(join(AGENTS_DIR, "../../../quality/opencode/agents/adversarial-challenger.md"))
  expect(copy).toEqual(file("adversarial-challenger"))
})

describe("delivery fallback for code-researcher", () => {
  test("delivery's code-researcher is the same agent apart from its fallback model", () => {
    const copy = loadAgents(["code-researcher"])[0]
    expect(copy?.description).toBe(codeResearcherFile.description)
    expect(copy?.system).toBe(codeResearcherFile.system)
    expect(copy?.permissions).toEqual(codeResearcherFile.permissions)
    expect(copy?.request).toEqual(codeResearcherFile.request)
  })

  test("delivery alone registers code-researcher", async () => {
    const fake = createFakeContext()
    await delivery.setup(fake.context)
    expect(fake.agents.get(CODE_RESEARCHER)?.system).toBe(codeResearcherFile.system)
  })

  const expectOne = (fake: ReturnType<typeof createFakeContext>) => {
    const agent = fake.agents.get(CODE_RESEARCHER) as Record<string, unknown>
    expect(agent.system).toBe(codeResearcherFile.system)
    expect(agent.permissions).toEqual([...codeResearcherFile.permissions, ...toolRules(DEFAULT_MCP_TOOLS)])
    expect(agent.model).toBeUndefined()
    expect(agent.request).toEqual(codeResearcherFile.request)
  }

  test("code-researcher then delivery: delivery leaves the registered agent alone", async () => {
    const fake = createFakeContext()
    await codeResearcher.setup(fake.context)
    await delivery.setup(fake.context)
    expectOne(fake)
    expect(fake.agentUpdates.filter((id) => id === CODE_RESEARCHER)).toHaveLength(1)
  })

  test("delivery then code-researcher, with plugin.list reporting agent-researcher: delivery skips its copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: "srobroek.delivery" }, { id: "srobroek.agent-researcher" }])
    await delivery.setup(fake.context)
    expect(fake.agents.has(CODE_RESEARCHER)).toBe(false)
    await codeResearcher.setup(fake.context)
    expectOne(fake)
  })

  test("delivery then code-researcher, unseen by plugin.list: code-researcher replaces the copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: "srobroek.delivery" }])
    const context = fake.context as unknown as Record<string, unknown>
    context.model = {
      list: async () => ({
        data: [{ providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5", variants: [{ id: "medium" }] }],
      }),
    }
    await delivery.setup(fake.context)
    expect(fake.agents.get(CODE_RESEARCHER)?.model).toBeDefined()
    await codeResearcher.setup(fake.context)
    expectOne(fake)
  })
})

describe("beads routing (FO-5) of code-researcher", () => {
  test("beads routing (FO-5) admits code-researcher for execution_agent_type=code-researcher", () => {
    const bead = [{ id: "repo-abc", agentType: CODE_RESEARCHER }]
    expect(decideRouting(CODE_RESEARCHER, bead).kind).toBe("allow")
    expect(decideRouting(`code-researcher:${CODE_RESEARCHER}`, bead).kind).toBe("allow")
    expect(decideRouting("general", bead).kind).toBe("block")
  })
})
