import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the project-secrets skill and disposes it", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["project-secrets"])
  await cleanup?.()
  expect(fake.active()).toBe(0)
})

test("project-secrets links every reference it names", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  const skill = fake.skills.get("project-secrets") as unknown as { path: string; content: string }
  const named = [...skill.content.matchAll(/`(references\/[\w-]+\.md)`/g)].map((match) => match[1] ?? "")
  expect(named.length).toBeGreaterThan(0)
  for (const reference of named) expect(existsSync(join(dirname(skill.path), reference))).toBe(true)
  for (const name of ["fnox-config", "ci-github", "mcp"])
    expect(existsSync(join(dirname(skill.path), "references", `${name}.md`))).toBe(true)
  await cleanup?.()
})
