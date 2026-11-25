#!/usr/bin/env bun
/**
 * Record the tools the design pi package's Playwright MCP server offers: start it with the
 * shipped command and arguments, ask for `tools/list`, and write the answer to
 * `plugins/design/pi-src/playwright-tools.json`. `plugins/design/pi-src/design.test.ts` checks
 * the hidden tools against that file, and fails when the pin moves until the file is recorded again.
 *
 *   bun scripts/record-playwright-tools.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PLAYWRIGHT_ARGS, PLAYWRIGHT_MCP_VERSION, playwrightMcp } from "../plugins/design/pi-src/playwright.ts"

const OUT = path.join(import.meta.dir, "..", "plugins", "design", "pi-src", "playwright-tools.json")
const TIMEOUT_MS = 120_000

type Message = { id?: number; method?: string; result?: { tools?: unknown[] }; error?: unknown }

const cwd = mkdtempSync(path.join(tmpdir(), "playwright-tools-"))
// The tool list does not depend on the browser mode; headless keeps the recording from opening a window.
const server = playwrightMcp(cwd, true)
const child = Bun.spawn([server.command, ...server.args], {
  cwd: server.cwd,
  env: { ...process.env, ...server.env },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
})
const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)

async function tools(): Promise<unknown[]> {
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "record-playwright-tools", version: "1" } } })
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
      if (!line) continue
      const message = JSON.parse(line) as Message
      if (message.method !== undefined && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "not supported" } })
      else if (message.id === 1) {
        send({ method: "notifications/initialized" })
        send({ id: 2, method: "tools/list", params: {} })
      } else if (message.id === 2) {
        if (!message.result?.tools) throw new Error(`tools/list failed: ${JSON.stringify(message.error)}`)
        return message.result.tools
      }
    }
  }
  throw new Error("the server closed before answering tools/list")
}

const timer = setTimeout(() => {
  child.kill()
  console.error(`no tools/list answer within ${TIMEOUT_MS / 1000}s`)
  process.exit(1)
}, TIMEOUT_MS)
try {
  const list = (await tools()) as { name: string; description?: string; inputSchema?: unknown }[]
  const recorded = list
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name))
  writeFileSync(OUT, `${JSON.stringify({ version: PLAYWRIGHT_MCP_VERSION, args: PLAYWRIGHT_ARGS, tools: recorded }, null, 2)}\n`)
  console.log(`recorded ${recorded.length} tools of @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} to ${path.relative(process.cwd(), OUT)}`)
} finally {
  clearTimeout(timer)
  child.kill()
  rmSync(cwd, { recursive: true, force: true })
}
