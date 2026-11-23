import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { COMMAND, challengePrompt } from "../opencode/src/command.ts"
import { SETUP_INPUT } from "../opencode/src/formulas.ts"
import { LIB_FACTS_INPUT } from "../opencode/src/lib-facts/index.ts"
import { cleanup, exited, fakeExec, temp, withTools } from "../opencode/src/scan/fixtures.ts"
import { SCAN_INPUT, type ScanDeps } from "../opencode/src/scan/index.ts"
import { VALIDATE_INPUT } from "../opencode/src/validate.ts"
import codeChallenge, { type ChallengeTool, registerCodeChallenge, toToolResult } from "./index.ts"

// The scan tests resolve real paths and run a fake exec; measured under 100 ms each, 30 s is headroom.
setDefaultTimeout(30_000)
afterAll(cleanup)

type Command = { description?: string; handler(args: string, ctx: unknown): Promise<void> | void }

/** A recording stand-in for the three ExtensionAPI calls the extension makes. */
function fakePi() {
  const tools = new Map<string, ChallengeTool>()
  const commands = new Map<string, Command>()
  const sent: string[] = []
  const api = {
    registerTool: (tool: ChallengeTool) => void tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => void commands.set(name, command),
    sendUserMessage: (content: string) => void sent.push(content),
  }
  return { api: api as unknown as ExtensionAPI, tools, commands, sent }
}

/** A tool context; `hasUI` and a confirm that fails the test show the scan never asks, with or without a UI. */
function context(cwd: string, hasUI: boolean) {
  return {
    cwd,
    hasUI,
    ui: {
      confirm: async () => {
        throw new Error("challenge_scan must not ask")
      },
    },
  } as unknown as ExtensionToolContext
}

/** Run a registered tool as the host would. */
function run(tool: ChallengeTool | undefined, params: unknown, ctx: ExtensionToolContext) {
  if (tool === undefined) throw new Error("tool not registered")
  return tool.execute("call_1", params as never, undefined, undefined, ctx)
}

describe("registration", () => {
  test("the default export registers the four tools with the OpenCode parameters, and the command", () => {
    const pi = fakePi()
    codeChallenge(pi.api)
    expect([...pi.tools.keys()].sort()).toEqual(["challenge_lib_facts", "challenge_scan", "challenge_setup", "challenge_validate"])
    expect(pi.tools.get("challenge_setup")?.parameters).toBe(SETUP_INPUT as never)
    expect(pi.tools.get("challenge_lib_facts")?.parameters).toBe(LIB_FACTS_INPUT as never)
    expect(pi.tools.get("challenge_validate")?.parameters).toBe(VALIDATE_INPUT as never)
    expect(pi.tools.get("challenge_scan")?.parameters).toBe(SCAN_INPUT as never)
    expect([...pi.commands.keys()]).toEqual([COMMAND])
  })

  test("OMP approval tiers: reads are read, the formula install writes, the scan executes", () => {
    const pi = fakePi()
    registerCodeChallenge(pi.api)
    const tier = (name: string) => pi.tools.get(name)?.approval
    expect([tier("challenge_lib_facts"), tier("challenge_validate"), tier("challenge_setup"), tier("challenge_scan")]).toEqual(["read", "read", "write", "exec"])
  })

  test("/code-challenge sends the Pi-host prompt for its arguments", async () => {
    const pi = fakePi()
    registerCodeChallenge(pi.api)
    await pi.commands.get(COMMAND)?.handler("auto deep src/http.ts", {})
    expect(pi.sent).toEqual([challengePrompt("auto deep src/http.ts", "pi")])
  })

  test("a handler outcome becomes one text block and details", () => {
    expect(toToolResult({ content: "ok", metadata: { ok: true } })).toEqual({ content: [{ type: "text", text: "ok" }], details: { ok: true } })
  })

  test("challenge_validate reads the session cwd and keeps the OpenCode result in host form", async () => {
    const pi = fakePi()
    registerCodeChallenge(pi.api)
    const result = await run(pi.tools.get("challenge_validate"), { run_dir: "relative" }, context(temp(), false))
    expect(result).toEqual({ content: [{ type: "text", text: "challenge_validate: run_dir must be an absolute path" }], details: { ok: false } })
  })
})

describe("challenge_scan through the extension", () => {
  const rustRepo = () => {
    const root = temp()
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\n')
    return root
  }
  const scan = async (params: object, hasUI: boolean) => {
    const calls: Parameters<typeof fakeExec>[1] = []
    const deps: ScanDeps = { exec: fakeExec({ clippy: exited("") }, calls), which: withTools("cargo") }
    const pi = fakePi()
    registerCodeChallenge(pi.api, deps)
    const result = await run(pi.tools.get("challenge_scan"), { languages: ["rust"], ...params }, context(rustRepo(), hasUI))
    const coverage = (result.details as { coverage: Array<{ recipe: string; status: string; reason?: string }> }).coverage
    return { clippy: coverage.find((c) => c.recipe === "clippy:lenses"), ranClippy: calls.some((c) => c.argv.includes("clippy")) }
  }

  test.each([false, true])("by default it runs no repository code and reports the recipe as a gap (hasUI %p)", async (hasUI) => {
    const { clippy, ranClippy } = await scan({}, hasUI)
    expect(clippy?.status).toBe("gap")
    expect(clippy?.reason).toStartWith("not run without allowCode: ")
    expect(clippy?.reason).toEndWith("; pass allowCode: true to run it")
    expect(ranClippy).toBe(false)
  })

  test.each([false, true])("allowCode runs the recipe without asking (hasUI %p)", async (hasUI) => {
    const { clippy, ranClippy } = await scan({ allowCode: true }, hasUI)
    expect(clippy?.status).toBe("ran")
    expect(ranClippy).toBe(true)
  })
})
