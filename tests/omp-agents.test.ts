import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseFrontmatter } from "../scripts/convert-agent.ts"

// OMP 19.1.1 task-agent frontmatter (omp://task-agent-discovery.md, "Agent definition shape"). A key
// outside it is ignored by OMP, so an OpenCode key leaking into an OMP agent silently does nothing.

const PLUGINS = path.resolve(import.meta.dir, "../plugins")
const OMP_AGENT_KEYS = new Set(["name", "description", "tools", "spawns", "model", "thinking-level", "output", "blocking", "autoloadSkills"])

const plugins = readdirSync(PLUGINS).sort()
const inDir = (dir: string, keep: (name: string) => boolean) =>
  existsSync(dir) ? readdirSync(dir).filter(keep).sort().map((name) => path.join(dir, name)) : []

const translated = plugins.flatMap((plugin) => inDir(path.join(PLUGINS, plugin, "common", "agents"), (name) => name.endsWith(".omp.md")))
const shipped = plugins.flatMap((plugin) => inDir(path.join(PLUGINS, plugin, "omp", "agents"), (name) => name.endsWith(".md")))

describe("OMP agents", () => {
  test("every OMP agent file uses only OMP task-agent keys and names itself after its file", () => {
    expect(shipped.map((file) => path.relative(PLUGINS, file))).toContain("agent-mechanic/omp/agents/mechanic.md")
    for (const file of [...translated, ...shipped]) {
      const { data } = parseFrontmatter(readFileSync(file, "utf8"))
      const id = path.basename(file).replace(/(\.omp)?\.md$/, "")
      const where = path.relative(PLUGINS, file)
      expect({ where, extra: Object.keys(data).filter((key) => !OMP_AGENT_KEYS.has(key)) }).toEqual({ where, extra: [] })
      expect({ where, name: data.name }).toEqual({ where, name: id })
    }
  })
})
