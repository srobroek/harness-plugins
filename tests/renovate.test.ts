import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const config = JSON.parse(readFileSync(path.join(root, "renovate.json"), "utf8"))

interface Manager {
  description: string
  managerFilePatterns: string[]
  matchStrings: string[]
}
const managers = config.customManagers as Manager[]

/** Renovate's "/regex/" pattern form; Renovate compiles named groups and lookaheads as JS does. */
const filePattern = (pattern: string) => new RegExp(pattern.slice(1, -1))

const files = [...new Bun.Glob("{docs,lib,plugins}/**").scanSync({ cwd: root, dot: true })].filter(
  (file) => !file.includes("node_modules/"),
)

/** Files that a disabling packageRule removes from every custom manager. */
const disabled = (config.packageRules as { enabled: boolean; matchFileNames: string[] }[])
  .filter((rule) => rule.enabled === false)
  .flatMap((rule) => rule.matchFileNames.map((glob) => new Bun.Glob(glob)))

function selected(manager: Manager): string[] {
  const patterns = manager.managerFilePatterns.map(filePattern)
  return files
    .filter((file) => patterns.some((pattern) => pattern.test(file)))
    .filter((file) => !disabled.some((glob) => glob.match(file)))
}

test("custom managers select sources only, never generated copies", () => {
  for (const manager of managers) {
    for (const file of selected(manager)) {
      expect(file).not.toMatch(/^plugins\/[^/]+\/claude\//)
      expect(file).not.toMatch(/^plugins\/[^/]+\/opencode\/(skills|agents|formulas|dist)\//)
      expect(file).not.toMatch(/^plugins\/cad\/(common|opencode\/examples)\//)
      expect(file).not.toMatch(/INVENTORY\.md$/)
      expect(file).not.toMatch(/^plugins\/[^/]+\/opencode\/\.mcp\.json$/)
    }
  }
})

test.each(managers.map((manager) => [manager.description, manager] as const))(
  "custom manager matches a real pin: %s",
  (_description, manager) => {
    const regexes = manager.matchStrings.map((source) => new RegExp(source, "g"))
    const hits = selected(manager).filter((file) => {
      const text = readFileSync(path.join(root, file), "utf8")
      return regexes.some((regex) => text.match(regex) !== null)
    })
    expect(hits.length).toBeGreaterThan(0)
  },
)
