import process from "node:process"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createGuard, type GuardOptions } from "../shared/guard.js"

const UNAVAILABLE_NOTICE =
  "chezmoi: unable to read the managed file list; writes are allowed until chezmoi is available."

/** Register the guard; options are a test seam for isolated chezmoi state. */
export function createExtension(pi: ExtensionAPI, options: GuardOptions = {}): void {
  let context: ExtensionContext | undefined
  const guard = createGuard({
    ...options,
    onUnavailable: () => {
      options.onUnavailable?.()
      if (context?.hasUI) context.ui.notify(UNAVAILABLE_NOTICE, "warning")
      else process.stderr.write(`${UNAVAILABLE_NOTICE}\n`)
    },
  })

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return
    context = ctx
    const reason = await guard.decide(event.toolName, event.input, ctx.cwd)
    if (reason) return { block: true, reason }
  })
}

export default function (pi: ExtensionAPI): void {
  createExtension(pi)
}
