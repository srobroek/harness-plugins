import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentDir, fileStorage, storageDir } from "./storage.ts"

const root = mkdtempSync(join(tmpdir(), "autopilot-pi-storage-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let count = 0
const fresh = () => join(root, `store-${++count}`)

test("a value set is read back, and a removed or never-set key is absent", async () => {
  const storage = fileStorage(fresh())
  expect(await storage.get("armed/ses_1")).toBeUndefined()
  await storage.set("armed/ses_1", { runId: "r", root: "/x" })
  expect(await storage.get("armed/ses_1")).toEqual({ runId: "r", root: "/x" })
  await storage.set("armed/ses_1", { runId: "s", root: "/y" })
  expect(await storage.get("armed/ses_1")).toEqual({ runId: "s", root: "/y" })
  await storage.remove("armed/ses_1")
  await storage.remove("armed/ses_1")
  expect(await storage.get("armed/ses_1")).toBeUndefined()
})

test("keys with slashes, @, * and dots map to one file each and leave no temporary file", async () => {
  const dir = fresh()
  const storage = fileStorage(dir)
  const keys = ["review-session/ses_a/12@abc", "review/12@abc", "a*b", "..", "x.json"]
  for (const key of keys) await storage.set(key, key)
  for (const key of keys) expect(await storage.get(key)).toBe(key)
  expect(readdirSync(dir).sort()).toHaveLength(keys.length)
  expect(readdirSync(dir).every((name) => name.endsWith(".json") && !name.includes("/"))).toBe(true)
})

test("a scan lists keys under a prefix in key order, pages with next, and resumes after a cursor", async () => {
  const storage = fileStorage(fresh())
  for (const key of ["armed/b", "armed/a", "armed/c", "review/1@x"]) await storage.set(key, key)
  expect(await storage.scan({ prefix: "armed/", limit: 10 })).toEqual({ entries: ["armed/a", "armed/b", "armed/c"].map((key) => ({ key, value: key })) })
  const first = await storage.scan({ prefix: "armed/", limit: 2 })
  expect(first).toEqual({ entries: [{ key: "armed/a", value: "armed/a" }, { key: "armed/b", value: "armed/b" }], next: "armed/b" })
  expect(await storage.scan({ prefix: "armed/", limit: 2, after: first.next as string })).toEqual({ entries: [{ key: "armed/c", value: "armed/c" }] })
})

test("a store that does not exist yet scans as empty", async () => {
  expect(await fileStorage(join(fresh(), "missing")).scan({ prefix: "", limit: 5 })).toEqual({ entries: [] })
})

test("a stored value that is not JSON is an error, never an absent key", async () => {
  const dir = fresh()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${encodeURIComponent("armed/ses_x")}.json`), "{not json")
  const storage = fileStorage(dir)
  await expect(storage.get("armed/ses_x")).rejects.toThrow("not JSON")
  await expect(storage.scan({ prefix: "armed/", limit: 5 })).rejects.toThrow("not JSON")
})

test("a store that cannot be listed is an error", async () => {
  const file = fresh()
  writeFileSync(file, "a file, not a directory")
  await expect(fileStorage(file).scan({ prefix: "", limit: 5 })).rejects.toThrow()
})

test("the agent directory follows PI_CODING_AGENT_DIR as pi reads it", () => {
  expect(agentDir({}, "/home/u")).toBe("/home/u/.pi/agent")
  expect(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/u")).toBe("/tmp/agent")
  expect(agentDir({ PI_CODING_AGENT_DIR: "~/alt" }, "/home/u")).toBe("/home/u/alt")
  expect(agentDir({ PI_CODING_AGENT_DIR: "~" }, "/home/u")).toBe("/home/u")
  expect(storageDir({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe("/tmp/agent/autopilot/storage")
})
