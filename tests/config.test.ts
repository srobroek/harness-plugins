import { expect, test } from "bun:test"
import path from "node:path"
import { loadConfig } from "@srobroek/harness-kit"

test("harness-kit.json is valid and targets OpenCode and Claude Code", () => {
  const config = loadConfig(path.join(import.meta.dir, ".."))
  expect(config.harnesses).toEqual(["opencode", "claude"])
  expect(config.marketplace.name).toBe("harness-plugins")
})
