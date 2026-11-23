import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"

const loadBundledExtension = async () => {
  const module = await import(new URL("../pi/extensions/chezmoi.js", import.meta.url).href)
  return module.createExtension as typeof import("./chezmoi.ts").createExtension
}

// Isolated chezmoi CLI calls complete in under a second on the local fixture.
setDefaultTimeout(30_000)

let tempRoot: string
let home: string
let source: string
let state: string
let managedTarget: string
let sourcePath: string
let writeHandler: ((event: ToolCallEvent, context: ExtensionContext) => unknown) | undefined
let handler: (event: ToolCallEvent, context: ExtensionContext) => unknown

async function chezmoi(args: string[]): Promise<string> {
  const proc = Bun.spawn(["chezmoi", "--source", source, "--destination", home, "--persistent-state", state, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`chezmoi ${args.join(" ")} failed (${exitCode}): ${stderr}`)
  return stdout
}

describe("chezmoi pi tool_call guard", () => {
  beforeEach(async () => {
    tempRoot = mkdtempSync(join(homedir(), "chezmoi-pi-guard-"))
    home = join(tempRoot, "home")
    source = join(tempRoot, "source")
    state = join(tempRoot, "state.json")
    managedTarget = join(home, ".config", "chezmoi-guard", "managed.txt")
    mkdirSync(join(home, ".config", "chezmoi-guard"), { recursive: true })
    mkdirSync(source, { recursive: true })
    writeFileSync(managedTarget, "managed\n")
    await chezmoi(["add", managedTarget])
    sourcePath = (await chezmoi(["source-path", managedTarget])).trim()

    const callbacks = new Map<string, (event: ToolCallEvent, context: ExtensionContext) => unknown>()
    const pi = {
      on: (name: string, callback: (event: ToolCallEvent, context: ExtensionContext) => unknown) => {
        callbacks.set(name, callback)
      },
    } as unknown as ExtensionAPI
    const createExtension = await loadBundledExtension()
    createExtension(pi, {
      home,
      globalArgs: ["--source", source, "--destination", home, "--persistent-state", state],
    })
    writeHandler = callbacks.get("tool_call")
    if (!writeHandler) throw new Error("Extension did not register tool_call")
    handler = writeHandler
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
    writeHandler = undefined
  })

  const call = (toolName: string, input: Record<string, unknown>) =>
    handler(
      { type: "tool_call", toolCallId: "test-call", toolName, input } as ToolCallEvent,
      { cwd: home, hasUI: false } as ExtensionContext,
    )

  test("blocks writes to managed targets and names the source path", async () => {
    const result = await call("write", { path: managedTarget, content: "changed\n" })
    expect(result).toMatchObject({ block: true })
    expect((result as { reason: string }).reason).toContain(sourcePath)
  })

  test("allows writes to unmanaged temporary files", async () => {
    const unmanaged = join(home, "unmanaged.txt")
    const result = await call("write", { path: unmanaged, content: "allowed\n" })
    expect(result).toBeUndefined()
  })

  test("blocks a literal bash redirect to a managed target", async () => {
    const result = await call("bash", { command: `printf x > '${managedTarget}'`, cwd: home })
    expect(result).toMatchObject({ block: true })
    expect((result as { reason: string }).reason).toContain(sourcePath)
  })

  test("ignores tools that cannot write targets according to this guard", async () => {
    expect(await call("read", { path: managedTarget })).toBeUndefined()
  })
})
