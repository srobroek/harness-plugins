import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PINS } from "./pins.ts"
import { RECIPES } from "./recipes.ts"
import { resolveTool } from "./run.ts"

const REPO = join(import.meta.dir, "../../../../..")
const PINS_PATH = "plugins/code-challenge/opencode/src/scan/pins.ts"

const only =
  (...names: string[]) =>
  (binary: string) =>
    names.includes(binary) ? `/bin/${binary}` : null
const recipe = (id: string) => RECIPES.find((r) => r.id === id) as (typeof RECIPES)[number]

describe("one-off pins", () => {
  test("a one-off run names the exact pinned version for each runner", () => {
    expect(resolveTool(recipe("oxlint:perf"), only("bunx"), "/t")).toMatchObject({
      prefix: ["/bin/bunx", "-p", "oxlint@1.94.0", "oxlint"],
    })
    expect(resolveTool(recipe("ruff:lenses"), only("uvx"), "/t")).toMatchObject({
      prefix: ["/bin/uvx", "--from", "ruff==0.17.6", "ruff"],
    })
    expect(resolveTool(recipe("deadcode:go"), only("go"), "/t")).toMatchObject({
      prefix: ["/bin/go", "run", "golang.org/x/tools/cmd/deadcode@v0.53.0"],
    })
  })

  test("every package a recipe runs one-off has an exact pin", () => {
    for (const r of RECIPES) if (r.package !== undefined) expect(PINS[r.package]).toMatch(/^v?\d+(\.\d+)*$/)
    for (const version of Object.values(PINS)) expect(version).toMatch(/^v?\d+(\.\d+)*$/)
  })

  test("the Renovate manager in renovate.json reads exactly the pins in pins.ts", () => {
    const config = JSON.parse(readFileSync(join(REPO, "renovate.json"), "utf8")) as {
      customManagers: Array<{ managerFilePatterns: string[]; matchStrings: string[] }>
    }
    const manager = config.customManagers.find((m) =>
      m.managerFilePatterns.some((p) => new RegExp(p.replace(/^\/|\/$/g, "")).test(PINS_PATH)),
    )
    expect(manager).toBeDefined()
    const source = readFileSync(join(REPO, PINS_PATH), "utf8")
    const found: Record<string, string> = {}
    for (const m of source.matchAll(new RegExp(manager?.matchStrings[0] ?? "", "g"))) {
      found[m.groups?.depName ?? ""] = m.groups?.currentValue ?? ""
    }
    expect(found).toEqual(PINS)
  })
})
