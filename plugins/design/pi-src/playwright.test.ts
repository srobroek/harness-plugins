// Checks the design package's Playwright MCP tool exposure against the tools the pinned server
// offers with the shipped arguments, as recorded in playwright-tools.json.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import {
  HEADLESS_ENV,
  HIDDEN_TOOLS,
  PLAYWRIGHT_ARGS,
  PLAYWRIGHT_MCP_VERSION,
  playwrightHeadless,
  playwrightMcp,
  TOOL_REVIEW,
} from "./playwright.ts"

type RecordedTool = {
  name: string
  description?: string
  inputSchema?: { properties?: Record<string, { description?: string }> }
}

const recording = JSON.parse(readFileSync(new URL("./playwright-tools.json", import.meta.url), "utf8")) as {
  version: string
  args: string[]
  tools: RecordedTool[]
}
const RERECORD = "run `bun scripts/record-playwright-tools.ts` and review TOOL_REVIEW"
const reviews: Readonly<Record<string, { kind: string }>> = TOOL_REVIEW

const parameters = (tool: RecordedTool) => Object.entries(tool.inputSchema?.properties ?? {})
/** Parameters that name a local file or path. */
const fileParameters = (tool: RecordedTool) => parameters(tool).filter(([key]) => /path|file/i.test(key))
/** Parameters that carry code to run. */
const codeParameters = (tool: RecordedTool) => parameters(tool).filter(([key]) => /code|function|script/i.test(key))

/** Tools that take a file, a path or code and that TOOL_REVIEW does not account for. */
function unreviewed(tools: readonly RecordedTool[]): string[] {
  return tools
    .filter((tool) => fileParameters(tool).length + codeParameters(tool).length > 0)
    .filter((tool) => reviews[tool.name] === undefined)
    .map((tool) => tool.name)
}

test("the recording is of the pinned release with the shipped arguments", () => {
  expect({ version: recording.version, args: recording.args, fix: RERECORD }).toEqual({
    version: PLAYWRIGHT_MCP_VERSION,
    args: [...PLAYWRIGHT_ARGS],
    fix: RERECORD,
  })
})

test("every recorded tool that takes a file, a path or code is reviewed", () => {
  expect({ unreviewed: unreviewed(recording.tools), fix: RERECORD }).toEqual({ unreviewed: [], fix: RERECORD })
})

test("the review check catches a new tool that reads local files", () => {
  const upload: RecordedTool = {
    name: "browser_new_upload",
    inputSchema: { properties: { paths: { description: "Absolute paths to files" } } },
  }
  expect(unreviewed([...recording.tools, upload])).toEqual(["browser_new_upload"])
})

test("every reviewed tool is one the pinned server offers", () => {
  const offered = new Set(recording.tools.map(({ name }) => name))
  expect(Object.keys(TOOL_REVIEW).filter((name) => !offered.has(name))).toEqual([])
})

test("a visible tool takes a file only to save its own output, and code only for the page", () => {
  for (const tool of recording.tools) {
    const review = reviews[tool.name]
    if (review === undefined || review.kind === "hidden") continue
    const files = fileParameters(tool)
    expect({ tool: tool.name, files: files.map(([key]) => key) }).toEqual({
      tool: tool.name,
      files: files.length > 0 ? ["filename"] : [],
    })
    for (const [, schema] of files) {
      expect({ tool: tool.name, saves: /\bsav(e|ed)\b/i.test(schema.description ?? "") }).toEqual({ tool: tool.name, saves: true })
      expect({ tool: tool.name, loads: /\b(load|read|upload|drop)\b/i.test(schema.description ?? "") }).toEqual({ tool: tool.name, loads: false })
    }
    if (codeParameters(tool).length > 0) {
      expect({ tool: tool.name, kind: review.kind }).toEqual({ tool: tool.name, kind: "page-script" })
      expect({ tool: tool.name, host: /server process|node|unsafe/i.test(tool.description ?? "") }).toEqual({ tool: tool.name, host: false })
    }
  }
})

test("the server hides the tools that read local files into the page or run code outside it", () => {
  expect(HIDDEN_TOOLS.toSorted()).toEqual(["browser_drop", "browser_file_upload", "browser_run_code_unsafe"])
  expect(playwrightMcp("/scratch", false).toolExposure).toEqual({
    browser_drop: "hidden",
    browser_file_upload: "hidden",
    browser_run_code_unsafe: "hidden",
  })
})

test("no optional capability or unrestricted file access is turned on", () => {
  const args: readonly string[] = PLAYWRIGHT_ARGS
  expect(args.filter((arg) => arg === "--caps" || arg === "--allow-unrestricted-file-access")).toEqual([])
  expect(PLAYWRIGHT_ARGS).toContain("--ignore-roots")
  expect(PLAYWRIGHT_ARGS).toContain("--isolated")
  expect(PLAYWRIGHT_ARGS).not.toContain("--headless")
  expect(recording.tools.map(({ name }) => name).filter((name) => /storage|cookie|route|pdf|tracing|video/.test(name))).toEqual([])
})

test("the server's working directory is the scratch workspace it is given", () => {
  expect(playwrightMcp("/scratch/pi-design-playwright-x", false)).toMatchObject({
    command: "npx",
    cwd: "/scratch/pi-design-playwright-x",
    args: [...PLAYWRIGHT_ARGS],
  })
  expect(PLAYWRIGHT_ARGS.slice(0, 2)).toEqual(["-y", `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`])
})

test("the browser is headed on macOS and on a Linux desktop, headless on a Linux host without a display", () => {
  expect(playwrightHeadless({}, "darwin")).toBe(false)
  expect(playwrightHeadless({}, "linux")).toBe(true)
  expect(playwrightHeadless({ DISPLAY: ":0" }, "linux")).toBe(false)
  expect(playwrightHeadless({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false)
  expect(playwrightHeadless({ DISPLAY: "" }, "linux")).toBe(true)
})

test("PLAYWRIGHT_MCP_HEADLESS overrides the rule both ways, and other values are ignored", () => {
  for (const value of ["1", "true"]) {
    expect(playwrightHeadless({ [HEADLESS_ENV]: value }, "darwin")).toBe(true)
    expect(playwrightHeadless({ [HEADLESS_ENV]: value, DISPLAY: ":0" }, "linux")).toBe(true)
  }
  for (const value of ["0", "false"]) {
    expect(playwrightHeadless({ [HEADLESS_ENV]: value }, "linux")).toBe(false)
  }
  expect(playwrightHeadless({ [HEADLESS_ENV]: "yes" }, "linux")).toBe(true)
  expect(playwrightHeadless({ [HEADLESS_ENV]: "yes" }, "darwin")).toBe(false)
})

test("the mode reaches the server as --headless and as an explicit PLAYWRIGHT_MCP_HEADLESS", () => {
  const headless = playwrightMcp("/w", true)
  expect(headless.args).toEqual([...PLAYWRIGHT_ARGS, "--headless"])
  expect(headless.env[HEADLESS_ENV]).toBe("true")
  expect(headless.description).toStartWith("Headless,")
  const headed = playwrightMcp("/w", false)
  expect(headed.args).toEqual([...PLAYWRIGHT_ARGS])
  expect(headed.env[HEADLESS_ENV]).toBe("false")
  expect(headed.description).toStartWith("Headed,")
})

test("the design agents select no MCP server but the package's isolated browser", () => {
  const agents = new URL("../common/agents/", import.meta.url)
  const selected = readdirSync(agents)
    .filter((file) => file.endsWith(".pi.md"))
    .flatMap((file) => {
      const tools = /^tools:(.*)$/m.exec(readFileSync(new URL(file, agents), "utf8"))?.[1] ?? ""
      return tools
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool.startsWith("mcp:"))
    })
  expect(selected.length).toBeGreaterThan(0)
  expect(new Set(selected)).toEqual(new Set(["mcp:playwright"]))
})
