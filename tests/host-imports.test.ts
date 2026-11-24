import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// OpenCode 2.2 serves `@opencode/plugin/effect` without `Tool`; a value import of it makes the whole bundle fail to load.
const plugins = join(import.meta.dir, "..", "plugins")

test("no opencode bundle value-imports Tool from the host effect module", () => {
  const offenders = readdirSync(plugins).filter((name) => {
    try {
      const bundle = readFileSync(join(plugins, name, "opencode", "dist", "index.js"), "utf8")
      return /import\s*\{[^}]*\bTool\b[^}]*\}\s*from\s*"@opencode\/plugin\/effect"/.test(bundle)
    } catch {
      return false
    }
  })
  expect(offenders).toEqual([])
})
