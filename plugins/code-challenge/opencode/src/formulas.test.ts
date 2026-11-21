import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { FORMULAS, FORMULAS_DIR, installFormulas } from "./formulas.ts"
import { PHASES } from "./lenses.ts"

type Step = { id: string; title: string; description?: string; needs?: string[]; metadata?: Record<string, unknown> }
type Formula = { formula: string; vars?: Record<string, { required?: boolean; default?: string }>; steps: Step[] }

const files = readdirSync(FORMULAS_DIR).filter((file) => file.endsWith(".formula.toml"))
const formulas = files.map((file) => {
  const text = readFileSync(join(FORMULAS_DIR, file), "utf8")
  return { name: file.replace(/\.formula\.toml$/, ""), text, data: Bun.TOML.parse(text) as Formula }
})
const mols = formulas.filter(({ name }) => name.startsWith("mol-"))

test("ships exactly the formulas challenge_setup installs, each named for its file", () => {
  expect(formulas.map(({ name }) => name).sort()).toEqual([...FORMULAS].sort())
  for (const { name, data } of formulas) expect(data.formula).toBe(name)
})

test("there is one mol per phase, named for it, plus the per-lens mol, and the full run has one step per phase in order", () => {
  expect(mols.map(({ name }) => name).sort()).toEqual(
    [...PHASES.map((phase) => `mol-challenge-${phase.toLowerCase()}`), "mol-challenge-lens"].sort(),
  )
  const full = formulas.find(({ name }) => name === "code-challenge")
  expect(full?.data.steps.map((step) => step.id)).toEqual(PHASES.map((phase) => phase.toLowerCase()))
  full?.data.steps.forEach((step, index) => {
    expect(step.needs ?? []).toEqual(index === 0 ? [] : [full.data.steps[index - 1]?.id as string])
  })
})

describe("formula content", () => {
  for (const { name, text, data } of formulas) {
    test(`${name} needs only its own steps and declares every var it uses`, () => {
      const ids = new Set(data.steps.map((step) => step.id))
      expect(ids.size).toBe(data.steps.length)
      for (const step of data.steps) for (const need of step.needs ?? []) expect(ids).toContain(need)
      const declared = new Set(Object.keys(data.vars ?? {}))
      for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) expect(declared).toContain(match[1] as string)
    })
  }

  test("phase mols declare required vars without defaults, because bd mol bond does not apply them", () => {
    for (const { name, data } of mols)
      for (const [key, spec] of Object.entries(data.vars ?? {})) {
        expect({ name, key, default: spec.default }).toEqual({ name, key, default: undefined })
        expect(spec.required).toBe(true)
      }
  })

  const agentsDir = join(import.meta.dir, "..", "..", "common", "agents")
  const routed = formulas.flatMap(({ name, data }) =>
    data.steps.flatMap((step) =>
      step.metadata?.execution_agent_type === undefined
        ? []
        : [{ name, step, agent: step.metadata.execution_agent_type as string }],
    ),
  )

  test("only per-lens analysis and the critique are routed, each to its own agent", () => {
    expect(routed.map(({ name, step, agent }) => `${name}/${step.id}/${agent}`).sort()).toEqual([
      "mol-challenge-lens/analyse-lens/code-challenger",
      "mol-challenge-refute/attack-findings/refactor-challenger",
    ])
  })

  test("the full run routes nothing: the lead sequences, dispatches and persists", () => {
    const full = formulas.find(({ name }) => name === "code-challenge")
    expect(full?.data.steps.filter((step) => step.metadata?.execution_agent_type !== undefined)).toEqual([])
  })

  for (const { name, step, agent } of routed) {
    test(`${name} ${step.id}: ${agent} is permitted every action the step requires and none it should not`, () => {
      const rules = readAgentFile(join(agentsDir, `${agent}.md`)).permissions
      expect(step.metadata?.execution_mode).toBe("subagent")
      const required = String(step.metadata?.requires_actions ?? "")
        .split(/,\s*/)
        .filter(Boolean)
      expect(required.length).toBeGreaterThan(0)
      for (const entry of required) {
        // "action" or "action:resource"; a skill is allowed per name, never as a whole.
        const [action = "", resource = "*"] = entry.split(":")
        expect({ entry, effect: permissionEffect(rules, action, resource) }).toEqual({ entry, effect: "allow" })
      }
      // Orchestration and persistence need these; a routed step must not ask for them.
      for (const action of ["edit", "write", "shell", "subagent", "challenge_setup"])
        expect(required.map((entry) => entry.split(":")[0])).not.toContain(action)
      const text = step.description ?? ""
      expect(text).not.toMatch(/\b(spawn|bond|append|create|commit|post)\b/i)
    })
  }
})

describe("installFormulas", () => {
  test("copies every formula once, then reports them unchanged, with the pour usage", () => {
    const repo = mkdtempSync(join(tmpdir(), "challenge-formulas-"))
    try {
      mkdirSync(join(repo, ".beads"))
      const first = installFormulas(".", repo)
      expect(first).toMatchObject({ ok: true, copied: [...FORMULAS], unchanged: [] })
      expect(first.text).toContain("bd mol pour code-challenge")
      expect(readdirSync(join(repo, ".beads", "formulas")).length).toBe(FORMULAS.length)
      expect(installFormulas(repo, "/elsewhere")).toMatchObject({ ok: true, copied: [], unchanged: [...FORMULAS] })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("refuses a directory that is not a beads workspace", () => {
    const repo = mkdtempSync(join(tmpdir(), "challenge-formulas-"))
    try {
      expect(installFormulas(repo, repo).ok).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
