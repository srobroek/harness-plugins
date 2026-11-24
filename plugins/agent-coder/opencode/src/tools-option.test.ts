import { describe, expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

const IDS = ["coder"]

const rulesOf = async (options?: Record<string, unknown>) => {
  const fake = createFakeContext({ options })
  await plugin.setup(fake.context)
  return (id: string) => fake.agents.get(id)?.permissions as AgentPermission[]
}

describe("tools option", () => {
  test.each(IDS)("%s allows Context7 by default and opts into AWS tools", async (id) => {
    const rules = (await rulesOf())(id)
    expect(rules.at(-1)).toEqual({ action: "context7_*", resource: "*", effect: "allow" })
    expect(permissionEffect(rules, "context7_query-docs")).toBe("allow")
    expect(permissionEffect(rules, "aws-mcp_search_documentation")).toBe("deny")
    const awsRules = (await rulesOf({ tools: ["aws-mcp_*"] }))(id)
    expect(permissionEffect(awsRules, "aws-mcp_search_documentation")).toBe("allow")
    expect(permissionEffect(rules, "other_tool")).toBe("deny")
  })

  test.each(IDS)("%s takes a custom list instead of the defaults", async (id) => {
    const rules = (await rulesOf({ tools: ["demo-server_lookup"] }))(id)
    expect(permissionEffect(rules, "demo-server_lookup")).toBe("allow")
    expect(permissionEffect(rules, "context7_query-docs")).toBe("deny")
  })

  test.each(IDS)("%s gets no MCP rules when tools is false", async (id) => {
    const rules = (await rulesOf({ tools: false }))(id)
    expect(permissionEffect(rules, "context7_query-docs")).toBe("deny")
    expect(permissionEffect(rules, "aws-mcp_x")).toBe("deny")
  })

  test.each(IDS)("%s refuses shell and * and keeps its boundary", async (id) => {
    const before = (await rulesOf({ tools: false }))(id)
    const warn = console.warn
    console.warn = () => {}
    try {
      const rules = (await rulesOf({ tools: ["shell", "*", "edit"] }))(id)
      expect(rules).toEqual(before)
    } finally {
      console.warn = warn
    }
  })
})
