import { afterAll, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { SECRET_STORE_INPUT, STORE_ACTION } from "../shared/secret-store.ts"
import { type Asker, createSecretStoreExtension, piStoreDeps } from "./secret-store.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "secret-store-pi-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Tool = { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }

function load(overrides: Parameters<typeof createSecretStoreExtension>[0] = {}) {
  const tools = new Map<string, Tool>()
  const pi = { registerTool: (tool: Tool) => tools.set(tool.name, tool) }
  createSecretStoreExtension(overrides)(pi as unknown as ExtensionAPI)
  return tools
}

function context(hasUI: boolean, cwd: string) {
  return { cwd, hasUI, ui: { notify: mock(() => {}), confirm: mock(async () => true) } }
}

describe("the extension", () => {
  test("registers safety_secret_store, which fails closed without a dialog and runs nothing", async () => {
    const project = join(root, "store")
    mkdirSync(project)
    writeFileSync(join(project, "fnox.toml"), '[providers.host]\ntype = "age"\n')
    const run = mock(async () => ({ kind: "exited" as const, exitCode: 0 }))
    const tools = load({ env: { PATH: "/bin" }, home: join(root, "home"), which: (bin) => `/bin/${bin}`, run })
    expect([...tools.keys()]).toEqual([STORE_ACTION])
    const tool = tools.get(STORE_ACTION)
    expect(tool?.parameters).toBe(SECRET_STORE_INPUT)
    const input = { name: "A", target: { kind: "fnox-store", provider: "host" }, generate: { charset: "hex", bytes: 16 } }
    const outcome = await tool?.execute("t1", input, undefined, undefined, context(false, project)).catch((error: Error) => error)
    expect(String(outcome)).toContain("cannot show a dialog; nothing was stored")
    expect(run).not.toHaveBeenCalled()
  })

  test("a call aborted before it starts stores nothing", async () => {
    const run = mock(async () => ({ kind: "exited" as const, exitCode: 0 }))
    const tool = load({ run }).get(STORE_ACTION)
    const aborted = AbortSignal.abort()
    const outcome = (await tool?.execute("t2", {}, aborted, undefined, context(true, root))) as { content: { text: string }[] }
    expect(outcome.content[0]?.text).toBe(`${STORE_ACTION} stopped before it started; nothing was stored.`)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("piStoreDeps", () => {
  test("a declined command run throws and names the step", async () => {
    const asker: Asker = { hasUI: true, ui: { confirm: async () => false } }
    const deps = piStoreDeps(root, asker, { env: {}, home: root })
    await expect(deps.askCommand(["gh", "auth", "token"], root)).rejects.toThrow("the user declined")
  })
})
