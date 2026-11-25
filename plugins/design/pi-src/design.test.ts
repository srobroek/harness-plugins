import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import { NPX_RUNNER, SCAN_TOOL } from "../shared/impeccable.ts"
import { IMPECCABLE_INSTALL, registerDesign, scanConsent } from "./design.ts"
import { PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_SERVER, playwrightHeadless, playwrightMcp } from "./playwright.ts"

type Tool = Parameters<ExtensionAPI["registerTool"]>[0]
type Execute = NonNullable<Tool["execute"]>

const clean: SupervisedRun = { kind: "exited", exitCode: 0, signalCode: null, stdout: "[]", stderr: "" }

function load(which: (bin: string) => string | null, makeWorkspace: () => string = () => "/scratch") {
  const tools: Tool[] = []
  const servers = new Map<string, unknown>()
  const handlers = new Map<string, () => unknown>()
  const runs: string[][] = []
  const pi = {
    registerTool: (tool: Tool) => tools.push(tool),
    registerMcpServer: (name: string, config: unknown) => servers.set(name, config),
    on: (event: string, handler: () => unknown) => handlers.set(event, handler),
  } as unknown as ExtensionAPI
  registerDesign(pi, {
    makeWorkspace,
    which,
    exec: async (argv) => {
      runs.push(argv)
      return clean
    },
  })
  const execute = tools[0]?.execute as Execute
  const call = (input: unknown, ctx: Record<string, unknown>) =>
    execute("call", input as never, new AbortController().signal, () => {}, { cwd: "/project", ...ctx } as never)
  const fire = (event: string) => handlers.get(event)?.()
  return { tools, servers, runs, call, fire }
}

const textOf = (result: Awaited<ReturnType<Execute>>) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")

test("loading registers only the scan tool and creates no directory", () => {
  let made = 0
  const { tools, servers } = load(
    () => null,
    () => {
      made++
      return "/scratch"
    },
  )
  expect(tools.map(({ name }) => name)).toEqual([SCAN_TOOL])
  expect([...servers.keys()]).toEqual([])
  expect(made).toBe(0)
})

test("the session start registers the Playwright server in a new workspace that shutdown removes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "design-pi-workspace-"))
  writeFileSync(join(workspace, "page.png"), "")
  let made = 0
  const { servers, fire } = load(
    () => null,
    () => {
      made++
      return workspace
    },
  )
  fire("session_start")
  fire("session_start")
  expect(made).toBe(1)
  expect([...servers.keys()]).toEqual([PLAYWRIGHT_SERVER])
  expect(servers.get(PLAYWRIGHT_SERVER)).toEqual(playwrightMcp(workspace, playwrightHeadless(process.env, process.platform)))
  fire("session_shutdown")
  expect(existsSync(workspace)).toBe(false)
  fire("session_shutdown")
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
