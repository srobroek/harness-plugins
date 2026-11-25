import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the debate skills and disposes them", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["debate", "grilling"])
  expect(fake.skills.get("debate")).not.toHaveProperty("autoinvoke")
  expect(fake.skills.get("grilling")).not.toHaveProperty("autoinvoke")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
