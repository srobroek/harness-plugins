import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { referenceReadRules } from "./read-grant.ts"

// A fake install: <root>/opencode/{src,skills/code-challenge/references}.
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "challenge-grant-")))
  mkdirSync(join(root, "opencode", "src"), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const moduleUrl = () => pathToFileURL(join(root, "opencode", "src", "index.js")).href
const skill = () => join(root, "opencode", "skills", "code-challenge")

function install(references: () => void) {
  mkdirSync(skill(), { recursive: true })
  writeFileSync(join(skill(), "SKILL.md"), "x")
  references()
}

test("a real references directory is granted, and only its files", () => {
  install(() => {
    mkdirSync(join(skill(), "references"))
    writeFileSync(join(skill(), "references", "evidence.md"), "x")
  })
  const warnings: string[] = []
  const rules = referenceReadRules(moduleUrl(), (message) => warnings.push(message))
  expect(permissionEffect(rules, "external_directory", join(skill(), "references", "evidence.md"))).toBe("allow")
  expect(permissionEffect(rules, "external_directory", join(skill(), "SKILL.md"))).toBe("ask")
  expect(warnings).toEqual([])
})

test.each([
  ["its parent (the skill directory)", () => skill()],
  ["a directory outside the plugin", () => join(root, "outside")],
])("a references symlink to %s gets no grant, and says so", (_name, target) => {
  mkdirSync(join(root, "outside"))
  writeFileSync(join(root, "outside", "secret.md"), "x")
  install(() => symlinkSync(target(), join(skill(), "references")))
  const warnings: string[] = []
  const rules = referenceReadRules(moduleUrl(), (message) => warnings.push(message))
  expect(rules).toEqual([])
  expect(permissionEffect(rules, "external_directory", join(skill(), "SKILL.md"))).toBe("ask")
  expect(permissionEffect(rules, "external_directory", join(root, "outside", "secret.md"))).toBe("ask")
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("no read grant")
})

test("a missing references directory gets no grant", () => {
  install(() => {})
  const warnings: string[] = []
  expect(referenceReadRules(moduleUrl(), (message) => warnings.push(message))).toEqual([])
  expect(warnings).toHaveLength(1)
})
