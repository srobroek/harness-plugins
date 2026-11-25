import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import { NPX_RUNNER, SCAN_TOOL } from "../shared/impeccable.ts"
import { IMPECCABLE_INSTALL, registerDesign, scanConsent } from "./design.ts"
import { PLAYWRIGHT_MCP, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_SERVER } from "./playwright.ts"

type Tool = Parameters<ExtensionAPI["registerTool"]>[0]
type Execute = NonNullable<Tool["execute"]>

const clean: SupervisedRun = { kind: "exited", exitCode: 0, signalCode: null, stdout: "[]", stderr: "" }

function load(which: (bin: string) => string | null) {
  const tools: Tool[] = []
  const servers = new Map<string, unknown>()
  const runs: string[][] = []
  const pi = {
    registerTool: (tool: Tool) => tools.push(tool),
    registerMcpServer: (name: string, config: unknown) => servers.set(name, config),
  } as unknown as ExtensionAPI
  registerDesign(pi, {
    which,
    exec: async (argv) => {
      runs.push(argv)
      return clean
    },
  })
  const execute = tools[0]?.execute as Execute
  const call = (input: unknown, ctx: Record<string, unknown>) =>
    execute("call", input as never, new AbortController().signal, () => {}, { cwd: "/project", ...ctx } as never)
  return { tools, servers, runs, call }
}

const textOf = (result: Awaited<ReturnType<Execute>>) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")

test("the extension registers the scan tool and the Playwright MCP server", () => {
  const { tools, servers } = load(() => null)
  expect(tools.map(({ name }) => name)).toEqual([SCAN_TOOL])
  expect([...servers.keys()]).toEqual([PLAYWRIGHT_SERVER])
  expect(servers.get(PLAYWRIGHT_SERVER)).toBe(PLAYWRIGHT_MCP)
})

test("the Playwright server is pinned, headless, isolated and hides the tools that leave the page", () => {
  expect(PLAYWRIGHT_MCP.command).toBe("npx")
  expect(PLAYWRIGHT_MCP.args.slice(0, 2)).toEqual(["-y", `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`])
  expect(PLAYWRIGHT_MCP.args).toContain("--headless")
  expect(PLAYWRIGHT_MCP.args).toContain("--isolated")
  expect(PLAYWRIGHT_MCP.toolExposure).toEqual({ browser_run_code_unsafe: "hidden", browser_file_upload: "hidden" })
})

test("the README pins the same @playwright/mcp release as the extension", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const pins = [...readme.matchAll(/@playwright\/mcp@(\d+\.\d+\.\d+)/g)].map((match) => match[1])
  expect(pins.length).toBeGreaterThan(0)
  expect(new Set(pins)).toEqual(new Set([PLAYWRIGHT_MCP_VERSION]))
})

test("the install hint is the prerequisite's mise route", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    "agent-plugins": { prerequisites: { bin: string; install: { mise: string } }[] }
  }
  const impeccable = manifest["agent-plugins"].prerequisites.find((entry) => entry.bin === "impeccable")
  expect(IMPECCABLE_INSTALL).toBe(`mise use -g ${impeccable?.install.mise}`)
})

test("scanConsent runs an installed impeccable, asks before npx, and refuses npx without a UI", () => {
  expect(scanConsent({ kind: "path", argv: ["/bin/impeccable"] }, false)).toBe("run")
  expect(scanConsent(NPX_RUNNER, true)).toBe("confirm")
  expect(scanConsent(NPX_RUNNER, false)).toBe("refuse")
})

test("an installed impeccable scans without a prompt, even in a session without a UI", async () => {
  const { runs, call } = load(() => "/usr/local/bin/impeccable")
  const result = await call({ targets: ["src"] }, { hasUI: false })
  expect(result.details).toMatchObject({ ok: true, status: "clean", runner: "path" })
  expect(runs).toEqual([["/usr/local/bin/impeccable", "detect", "--json", "/project/src"]])
})

test("without impeccable on PATH a session without a UI is refused before npx runs", async () => {
  const { runs, call } = load(() => null)
  const result = await call({ targets: ["src"] }, { hasUI: false })
  expect(result.details).toMatchObject({ ok: false, status: "refused", runner: "npx" })
  expect(textOf(result)).toContain(IMPECCABLE_INSTALL)
  expect(runs).toEqual([])
})

test("npx runs only after the user confirms the download", async () => {
  const { runs, call } = load(() => null)
  const questions: string[] = []
  const declined = await call({ targets: ["src"] }, { hasUI: true, ui: { confirm: async () => false } })
  expect(declined.details).toMatchObject({ ok: false, status: "cancelled" })
  expect(runs).toEqual([])
  const accepted = await call(
    { targets: ["src"], viewport: "375x812" },
    {
      hasUI: true,
      ui: {
        confirm: async (_title: string, message: string) => {
          questions.push(message)
          return true
        },
      },
    },
  )
  expect(accepted.details).toMatchObject({ ok: true, status: "clean", runner: "npx" })
  expect(questions[0]).toContain("/project/src")
  expect(runs).toEqual([["npx", "--yes", "impeccable", "detect", "--json", "--viewport", "375x812", "/project/src"]])
})

test("invalid input is reported without running anything", async () => {
  const { runs, call } = load(() => "/bin/impeccable")
  const result = await call({ targets: ["--help"] }, { hasUI: true })
  expect(result.details).toMatchObject({ ok: false })
  expect(textOf(result)).toContain('starts with "-"')
  expect(runs).toEqual([])
})
