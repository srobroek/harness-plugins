import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { decideRouting } from "../plugins/beads/opencode/src/subagent-routing.ts"
import { checkText } from "../scripts/check-steering.ts"

// Checks that span plugins: a formula in one plugin names a subagent that the beads routing gate decides on,
// and the formulas of every plugin follow the repository's steering rules. A plugin's own tests cover the rest
// of its formulas without importing another plugin.

const PLUGINS = path.resolve(import.meta.dir, "../plugins")

type Step = { id: string; metadata?: Record<string, unknown> }

const formulas = readdirSync(PLUGINS).flatMap((plugin) => {
  const directory = path.join(PLUGINS, plugin, "common", "formulas")
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => file.endsWith(".formula.toml"))
    .map((file) => {
      const text = readFileSync(path.join(directory, file), "utf8")
      return { plugin, file, text, steps: (Bun.TOML.parse(text) as { steps?: Step[] }).steps ?? [] }
    })
})

const routed = formulas.flatMap(({ plugin, file, steps }) =>
  steps.flatMap((step) =>
    typeof step.metadata?.execution_agent_type === "string" ? [{ plugin, file, step, type: step.metadata.execution_agent_type }] : [],
  ),
)

describe("beads routing (FO-5) of formula steps", () => {
  test("formula routing includes the plugins that define delegated workflow steps", () => {
    expect(new Set(routed.map(({ plugin }) => plugin))).toEqual(new Set(["code-challenge", "design", "speckit-beads"]))
  })

  for (const { plugin, file, step, type } of routed) {
    test(`${plugin} ${file} ${step.id}: the gate admits ${type} and blocks general`, () => {
      const bead = [{ id: "repo-mol-abc", agentType: type }]
      expect(decideRouting(type, bead).kind).toBe("allow")
      expect(decideRouting(`${plugin}:${type}`, bead).kind).toBe("allow")
      expect(decideRouting("general", bead).kind).toBe("block")
    })
  }
})

describe("formula steering", () => {
  test("formulas exist to check", () => {
    expect(formulas.length).toBeGreaterThan(0)
  })

  for (const { plugin, file, text } of formulas) {
    test(`${plugin} ${file} carries no omp steering`, () => {
      expect(checkText(file, text)).toEqual([])
    })
  }
})
