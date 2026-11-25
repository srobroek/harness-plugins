import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadPiPluginSettings, PI_SETTINGS_FILE } from "./pi-settings.ts"
import { piAgentDir } from "./testing.ts"

let root = ""
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "pi-settings-")))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A fresh agent directory whose `settings.json` holds `text`; returns the settings path. */
const settings = (text: string): string => join(piAgentDir(root, text), PI_SETTINGS_FILE)

const load = (path: string) => loadPiPluginSettings(path, "demo", "the defaults apply")

describe("loadPiPluginSettings", () => {
  test("a missing settings file gives no options and no warning", () => {
    expect(load(join(root, "absent", PI_SETTINGS_FILE))).toEqual({ options: {} })
  })

  test("a settings file without the plugin's key gives no options and no warning", () => {
    expect(load(settings('{ "defaultModel": "m", "subagents": { "gitWrappers": ["dgit"] } }'))).toEqual({ options: {} })
  })

  test("returns the object under the plugin's key and nothing beside it", () => {
    const path = settings('{ "defaultModel": "m", "demo": { "gitWrappers": ["git", "dgit"] }, "other": { "x": 1 } }')
    expect(load(path)).toEqual({ options: { gitWrappers: ["git", "dgit"] } })
  })

  test("reads a file with a byte-order mark, as pi does", () => {
    expect(load(settings('\uFEFF{ "demo": { "a": 1 } }'))).toEqual({ options: { a: 1 } })
  })

  test("ignores the plugin's old file beside settings.json", () => {
    const path = settings('{ "defaultModel": "m" }')
    writeFileSync(join(path, "..", "demo.json"), '{ "gitWrappers": ["git", "dgit"] }')
    expect(load(path)).toEqual({ options: {} })
  })

  test("a key whose value is not an object warns with the plugin, the key, the path and the fallback", () => {
    for (const value of ["[1]", "null", '"x"', "3", "false"]) {
      const path = settings(`{ "demo": ${value} }`)
      expect(load(path)).toEqual({ options: {}, warning: `demo: the "demo" key in ${path} is not an object; the defaults apply.` })
    }
  })

  test("malformed JSON warns", () => {
    const path = settings('{ "demo": ')
    expect(load(path)).toEqual({
      options: {},
      warning: `demo: ${path} is not valid JSON, so its "demo" key was not read; the defaults apply.`,
    })
  })

  test("a settings file that is not a JSON object warns", () => {
    const path = settings("[]")
    expect(load(path)).toEqual({
      options: {},
      warning: `demo: ${path} is not a JSON object, so its "demo" key was not read; the defaults apply.`,
    })
  })

  test("an unreadable settings path warns", () => {
    const path = join(root, "unreadable", PI_SETTINGS_FILE)
    mkdirSync(path, { recursive: true })
    expect(load(path)).toEqual({
      options: {},
      warning: `demo: ${path} could not be read, so its "demo" key was not read; the defaults apply.`,
    })
  })
})
