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
import codeChallenge, { type ChallengeContext, type ChallengeTool, CONSENT_TIMEOUT_MS, registerCodeChallenge, scanConsent, toToolResult } from "./index.ts"

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

type Asked = { title: string; message: string; options?: object }

/** A tool context with a recording confirm that answers `answer`; `hasUI: false` when `answer` is undefined. */
function context(cwd: string, answer?: boolean): ChallengeContext & { asked: Asked[] } {
  const asked: Asked[] = []
  return {
    cwd,
    hasUI: answer !== undefined,
    asked,
    ui: {
      confirm: async (title, message, options) => {
        asked.push({ title, message, options })
        return answer ?? false
      },
    },
  }
}

/** Run a registered tool as the host would, with `ctx` standing in for the full tool context. */
function run(tool: ChallengeTool | undefined, params: unknown, ctx: ChallengeContext, signal?: AbortSignal) {
  if (tool === undefined) throw new Error("tool not registered")
  return tool.execute("call_1", params as never, signal, undefined, ctx as unknown as ExtensionToolContext)
}

const RISK = { root: "/repo", depth: "standard", risks: [{ recipe: "clippy:lenses", tool: "clippy", reasons: ["builds the crate"] }], resource: "/repo [clippy:lenses]" }

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
    const result = await run(pi.tools.get("challenge_validate"), { run_dir: "relative" }, context(temp()))
    expect(result).toEqual({ content: [{ type: "text", text: "challenge_validate: run_dir must be an absolute path" }], details: { ok: false } })
  })
})

describe("the scan consent gate", () => {
  test("without an interactive UI it refuses and never prompts", async () => {
    const ctx = context("/repo")
    await expect(scanConsent(ctx, undefined)(RISK)).rejects.toThrow(
      "challenge_scan: consent needs an interactive session to approve clippy:lenses; no analyzer ran; pass staticOnly to scan without these recipes",
    )
    expect(ctx.asked).toEqual([])
  })

  test("asks with the consent message and a timeout, and a no refuses", async () => {
    const ctx = context("/repo", false)
    const signal = new AbortController().signal
    await expect(scanConsent(ctx, signal)(RISK)).rejects.toThrow("challenge_scan: consent refused; no analyzer ran")
    expect(ctx.asked).toHaveLength(1)
    expect(ctx.asked[0]?.message).toContain("challenge_scan in /repo will run code that is not static analysis.")
    expect(ctx.asked[0]?.message).toContain("- clippy:lenses: builds the crate")
    expect(ctx.asked[0]?.options).toEqual({ signal, timeout: CONSENT_TIMEOUT_MS })
  })

  test("a yes approves", async () => {
    await expect(scanConsent(context("/repo", true), undefined)(RISK)).resolves.toBeUndefined()
  })

  test("an aborted call refuses before asking", async () => {
    const ctx = context("/repo", true)
    const controller = new AbortController()
    controller.abort()
    await expect(scanConsent(ctx, controller.signal)(RISK)).rejects.toThrow()
    expect(ctx.asked).toEqual([])
  })

  const rustRepo = () => {
    const root = temp()
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\n')
    return root
  }
  const scanTool = (deps: ScanDeps) => {
    const pi = fakePi()
    registerCodeChallenge(pi.api, deps)
    return pi.tools.get("challenge_scan")
  }

  test("challenge_scan in a session without UI refuses a risky plan and runs no analyzer", async () => {
    const calls: Parameters<typeof fakeExec>[1] = []
    const tool = scanTool({ exec: fakeExec({ clippy: exited("") }, calls), which: withTools("cargo") })
    await expect(run(tool, { languages: ["rust"] }, context(rustRepo()))).rejects.toThrow("consent needs an interactive session")
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(false)
  })

  test("challenge_scan runs the approved recipe after a yes", async () => {
    const calls: Parameters<typeof fakeExec>[1] = []
    const tool = scanTool({ exec: fakeExec({ clippy: exited("") }, calls), which: withTools("cargo") })
    const ctx = context(rustRepo(), true)
    const result = await run(tool, { languages: ["rust"] }, ctx)
    expect(ctx.asked).toHaveLength(1)
    expect(result.details).toMatchObject({ ok: true })
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(true)
  })

  test("challenge_scan with staticOnly needs no UI", async () => {
    const tool = scanTool({ exec: fakeExec({}), which: withTools("cargo") })
    const result = await run(tool, { languages: ["rust"], staticOnly: true }, context(rustRepo()))
    expect(result.details).toMatchObject({ ok: true })
  })
})
