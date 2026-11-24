import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadPiOptionsFile } from "./pi-options.ts"

let root = ""
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "pi-options-")))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function file(name: string, text: string): string {
  const path = join(root, name)
  writeFileSync(path, text)
  return path
}

describe("loadPiOptionsFile", () => {
  test("a missing file gives no options and no warning", () => {
    expect(loadPiOptionsFile(join(root, "missing.json"), "demo", "the defaults apply")).toEqual({ options: {} })
  })

  test("returns the file's top-level object", () => {
    const path = file("ok.json", '{ "gitWrappers": ["git", "dgit"] }')
    expect(loadPiOptionsFile(path, "demo", "the defaults apply")).toEqual({ options: { gitWrappers: ["git", "dgit"] } })
  })

  test("JSON that is not an object gives no options and no warning", () => {
    expect(loadPiOptionsFile(file("list.json", "[1]"), "demo", "x")).toEqual({ options: {} })
    expect(loadPiOptionsFile(file("null.json", "null"), "demo", "x")).toEqual({ options: {} })
  })

  test("malformed JSON warns with the plugin, the path and the fallback", () => {
    const path = file("bad.json", "{")
    expect(loadPiOptionsFile(path, "demo", "the defaults apply")).toEqual({
      options: {},
      warning: `demo: ${path} is not valid JSON; the defaults apply.`,
    })
  })

  test("an unreadable path warns", () => {
    const path = join(root, "dir.json")
    mkdirSync(path)
    expect(loadPiOptionsFile(path, "demo", "the defaults apply")).toEqual({
      options: {},
      warning: `demo: ${path} could not be read; the defaults apply.`,
    })
  })
})
