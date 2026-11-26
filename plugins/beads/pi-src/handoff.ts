import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import type { SessionHeaderView } from "@srobroek/opencode-lib/pi-session-header"

export type Assignment = { bead: string; event: string; since: string; cwd: string; store: string; parent: string; actor: string }
export type VerifyProgress = (assignment: Assignment, actor: string, env: NodeJS.ProcessEnv) => Promise<boolean>
const execute = promisify(execFile)

export function verifyWithHelper(script: string): VerifyProgress {
  return async (a, actor, env) => {
    const { stdout } = await execute("python3", ["-I", script, "progress", a.bead, "--actor", actor, "--event", a.event, "--since", a.since], {
      cwd: a.cwd, env: { ...env, BEADS_DIR: a.store }, timeout: 35_000, maxBuffer: 16_384,
    })
    const result = JSON.parse(stdout)
    return result?.ok === true && result.bead === a.bead && result.kind === "progress" && result.event === a.event
  }
}

export function bindHandoff(input: Record<string, unknown>, context: () => { cwd: string; store?: string; parent?: string; actor: string; now: number }): Assignment | string | undefined {
  if (typeof input.task !== "string") return undefined
  const first = input.task.split("\n", 1)[0]?.trim() ?? ""
  if (!first.startsWith("Bead:")) return undefined
  const bead = /^Bead: ([a-zA-Z0-9][\w.-]{0,199})$/.exec(first)?.[1]
  if (!bead) return "Use Bead: FULL_ID on the first line of the worker task."
  if (input.async !== false || typeof input.agent !== "string" || input.workflow !== undefined || input.action !== undefined) {
    return "A Bead: assignment requires a single foreground subagent (async: false)."
  }
  const { cwd, store, parent, actor, now } = context()
  if (!store || !parent) return "A tracked handoff needs an active coordinator ledger and a persisted parent session."
  const event = randomUUID()
  input.task += `\n\nBefore returning, post a progress checkpoint on ${bead} using this child's Beads actor and event ${event}. Start the comment with beads-work/v1 followed by a space and a JSON object. Set kind to "progress" and event to "${event}". Supply three nonblank strings: result (what happened), evidence (a checkable reference), and next (the next action or owner). Do not close the bead.`
  return { bead, event, cwd, store, parent, actor, since: new Date(Math.floor(now / 1000) * 1000).toISOString() }
}

export async function handoffVerified(a: Assignment, details: unknown, readHeader: (path: string) => SessionHeaderView | undefined, verify: VerifyProgress, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const results = (details as {results?: unknown} | null)?.results
    if (!Array.isArray(results) || results.length !== 1) return false
    const child = results[0]
    if (child?.exitCode !== 0 || child.detached || child.interrupted || child.timedOut || child.stopped || child.error || typeof child.sessionFile !== "string") return false
    const header = readHeader(child.sessionFile)
    if (!header || header.parentSession !== a.parent || !/^[a-zA-Z0-9][\w.-]{0,127}$/.test(header.id)) return false
    return await verify(a, `${a.actor}/${header.id}`, env)
  } catch {
    return false
  }
}
