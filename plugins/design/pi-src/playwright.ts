// The browser the pi design agents drive: Playwright MCP, registered by the design extension.
import type { McpServerConfig } from "@earendil-works/pi-coding-agent"

/** The @playwright/mcp release the server runs; Renovate bumps it (renovate.json). */
export const PLAYWRIGHT_MCP_VERSION = "0.0.86"

export const PLAYWRIGHT_SERVER = "playwright"

/**
 * The server's arguments, whatever the browser mode: Chrome with an in-memory profile, sized like
 * the widest ui-review width. `--headless` is added only when `playwrightHeadless` says so. There
 * is no `--caps`, so the `storage`, `network`, `pdf`, `devtools` and `vision` capabilities are off:
 * `browser_set_storage_state`, `browser_route` and `browser_pdf_save` are not offered
 * (playwright-tools.json lists all 25 tools 0.0.86 offers with these arguments, in either mode).
 * `--ignore-roots` makes the server's `cwd` its only workspace root, whatever roots the client
 * advertises, and there is no `--allow-unrestricted-file-access`: file writes outside that root are
 * refused and `file:` URLs are blocked.
 */
export const PLAYWRIGHT_ARGS = [
  "-y",
  `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
  "--isolated",
  "--browser",
  "chrome",
  "--viewport-size",
  "1440x900",
  "--ignore-roots",
  "--file-paths",
  "absolute",
] as const

/** The variable that picks the mode, read the way Playwright MCP's own `envToBoolean` reads it. */
export const HEADLESS_ENV = "PLAYWRIGHT_MCP_HEADLESS"

/**
 * Whether the browser runs headless. `PLAYWRIGHT_MCP_HEADLESS` set to `1`/`true` or `0`/`false`
 * wins; any other value is ignored. Otherwise the browser is headed on macOS, or elsewhere when
 * `DISPLAY` or `WAYLAND_DISPLAY` is set, and headless on a host with no display, where a headed
 * Chrome cannot start.
 */
export function playwrightHeadless(env: Readonly<Record<string, string | undefined>>, platform: string): boolean {
  const forced = env[HEADLESS_ENV]
  if (forced === "1" || forced === "true") return true
  if (forced === "0" || forced === "false") return false
  if (platform === "darwin") return false
  return !env.DISPLAY && !env.WAYLAND_DISPLAY
}

/**
 * What the package does with each tool that takes a local path, a file name or code, as recorded
 * in playwright-tools.json (`scripts/record-playwright-tools.ts`):
 * - `hidden`: it reads a local file into the page, or runs code outside the page.
 * - `writes-output`: its only file parameter is `filename`, which saves the tool's own output
 *   (a snapshot, a screenshot, console or network logs, a search or evaluate result). The server
 *   writes only inside its workspace root, the scratch directory the extension makes, so these
 *   tools cannot overwrite a project file, even from a read-only agent.
 * - `page-script`: it runs JavaScript inside the page, with the page's own rights. The
 *   ui-review probes need it for computed styles; it cannot reach the host. Its `filename` is
 *   output only, as above.
 */
export const TOOL_REVIEW = {
  browser_run_code_unsafe: { kind: "hidden", why: "runs code, or a local file's code, in the server's Node process" },
  browser_file_upload: { kind: "hidden", why: "hands local files to the page" },
  browser_drop: { kind: "hidden", why: "drops local files onto the page" },
  browser_evaluate: { kind: "page-script", why: "runs the ui-review probes inside the page" },
  browser_console_messages: { kind: "writes-output", why: "may save the console log" },
  browser_find: { kind: "writes-output", why: "may save the search result" },
  browser_network_request: { kind: "writes-output", why: "may save one request" },
  browser_network_requests: { kind: "writes-output", why: "may save the request list" },
  browser_snapshot: { kind: "writes-output", why: "may save the ARIA snapshot" },
  browser_take_screenshot: { kind: "writes-output", why: "saves the screenshot" },
} as const satisfies Record<string, { kind: "hidden" | "writes-output" | "page-script"; why: string }>

export const HIDDEN_TOOLS = Object.entries(TOOL_REVIEW)
  .filter(([, review]) => review.kind === "hidden")
  .map(([name]) => name)

/**
 * Pi `mcpServers` entry. `workspace` is the server's `cwd` and its only workspace root, so the
 * snapshots and screenshots it saves land there and nowhere in the project. `headless` comes from
 * `playwrightHeadless`. It is passed both as `--headless` and as `PLAYWRIGHT_MCP_HEADLESS`, which
 * overrides the inherited variable, so the server cannot fall back on its own rule (headless on
 * Linux without `DISPLAY`, which ignores Wayland). A `playwright` server in the user's or a
 * trusted project's mcp.json wins. `npm_config_registry` keeps a project `.npmrc` registry from
 * breaking npx, as in common/.mcp.json.
 */
export function playwrightMcp(workspace: string, headless: boolean) {
  return {
    command: "npx",
    args: [...PLAYWRIGHT_ARGS, ...(headless ? ["--headless"] : [])],
    cwd: workspace,
    env: { npm_config_registry: "https://registry.npmjs.org/", [HEADLESS_ENV]: headless ? "true" : "false" },
    description: `${headless ? "Headless" : "Headed"}, isolated Chrome for rendered-UI review: ARIA snapshots, page evaluation, resize, keyboard, console, network and screenshots.`,
    toolExposure: Object.fromEntries(HIDDEN_TOOLS.map((tool) => [tool, "hidden" as const])),
  } satisfies McpServerConfig
}
