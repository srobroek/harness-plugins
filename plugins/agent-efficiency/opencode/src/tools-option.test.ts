import { describe, expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

const stockExplore = () => ({
  id: "explore",
  system: "You are a file search specialist.",
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
  ] as AgentPermission[],
})

const exploreRules = async (options?: Record<string, unknown>) => {
  const fake = createFakeContext({ agents: [stockExplore()], options })
  await plugin.setup(fake.context)
  return fake.agents.get("explore")?.permissions as AgentPermission[]
}

describe("explore tools option", () => {
  test("allows Context7 by default and opts into AWS tools", async () => {
    const rules = await exploreRules()
    expect(rules.at(-1)).toEqual({ action: "context7_*", resource: "*", effect: "allow" })
    expect(permissionEffect(rules, "context7_query-docs")).toBe("allow")
    expect(permissionEffect(rules, "aws-mcp_search_documentation")).toBe("deny")
    expect(permissionEffect(rules, "other_tool")).toBe("deny")
    expect(permissionEffect(rules, "edit")).toBe("deny")
    const awsRules = await exploreRules({ tools: ["aws-mcp_*"] })
    expect(permissionEffect(awsRules, "aws-mcp_search_documentation")).toBe("allow")
  })

  test("takes a custom list instead of the defaults", async () => {
    const rules = await exploreRules({ tools: ["demo-server_lookup"] })
    expect(permissionEffect(rules, "demo-server_lookup")).toBe("allow")
    expect(permissionEffect(rules, "context7_query-docs")).toBe("deny")
  })

  test("gets no MCP rules when tools is false", async () => {
    const rules = await exploreRules({ tools: false })
    expect(permissionEffect(rules, "context7_query-docs")).toBe("deny")
  })

  test("refuses shell and * and keeps its boundary", async () => {
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(await exploreRules({ tools: ["shell", "*"] })).toEqual(await exploreRules({ tools: false }))
    } finally {
      console.warn = warn
    }
  })
})
