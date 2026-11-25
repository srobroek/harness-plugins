// The browser the pi design agents drive: Playwright MCP, registered by the design extension.
import type { McpServerConfig } from "@earendil-works/pi-coding-agent"

/** The @playwright/mcp release the server runs; Renovate bumps it (renovate.json). */
export const PLAYWRIGHT_MCP_VERSION = "0.0.86"

export const PLAYWRIGHT_SERVER = "playwright"

/**
 * Pi `mcpServers` entry: a headless Chrome with an in-memory profile, sized like the widest
 * ui-review width. A `playwright` server in the user's or a trusted project's mcp.json wins.
 * `npm_config_registry` keeps a project `.npmrc` registry from breaking npx, as in common/.mcp.json.
 * Two tools reach past the page and no design step needs them, so they are hidden:
 * `browser_run_code_unsafe` runs code in the server's Node process, and `browser_file_upload`
 * hands a local file to the page.
 */
export const PLAYWRIGHT_MCP = {
  command: "npx",
  args: [
    "-y",
    `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
    "--headless",
    "--isolated",
    "--browser",
    "chrome",
    "--viewport-size",
    "1440x900",
  ],
  env: { npm_config_registry: "https://registry.npmjs.org/" },
  description:
    "Headless, isolated Chrome for rendered-UI review: ARIA snapshots, page evaluation, resize, keyboard, console, network and screenshots.",
  toolExposure: { browser_run_code_unsafe: "hidden", browser_file_upload: "hidden" },
} satisfies McpServerConfig
