// Checks the design package's Playwright MCP tool exposure against the tools the pinned server
// offers with the shipped arguments, as recorded in playwright-tools.json.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { HIDDEN_TOOLS, PLAYWRIGHT_ARGS, PLAYWRIGHT_MCP_VERSION, playwrightMcp, TOOL_REVIEW } from "./playwright.ts"

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
  expect(playwrightMcp("/scratch").toolExposure).toEqual({
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
  expect(PLAYWRIGHT_ARGS).toContain("--headless")
  expect(recording.tools.map(({ name }) => name).filter((name) => /storage|cookie|route|pdf|tracing|video/.test(name))).toEqual([])
})

test("the server's working directory is the scratch workspace it is given", () => {
  expect(playwrightMcp("/scratch/pi-design-playwright-x")).toMatchObject({
    command: "npx",
    cwd: "/scratch/pi-design-playwright-x",
    args: [...PLAYWRIGHT_ARGS],
  })
  expect(PLAYWRIGHT_ARGS.slice(0, 2)).toEqual(["-y", `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`])
})
