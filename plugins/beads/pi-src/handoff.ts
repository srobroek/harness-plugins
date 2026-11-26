import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import type { SessionHeaderView } from "@srobroek/opencode-lib/pi-session-header"

export type Assignment = { background?: boolean; bead: string; event: string; since: string; cwd: string; store: string; parent: string; actor: string }
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

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

function installBackgroundCheck(input: Record<string, unknown>, a: Assignment, script: string): string | undefined {
  const opts = input.options
  if (process.platform === "win32" || !object(opts) || !object(opts.acceptance) || opts.acceptance.level !== "verified" || !Array.isArray(opts.acceptance.verify)) {
    return 'For a tracked background worker, use local POSIX Pi and explicit options.acceptance {level:"verified", verify:[...]}; retain any required agent checks. Otherwise use async:false.'
  }
  for (const key of ["gate", "agentContract", "sessionDir", "machine", "script", "resume", "tasks", "chain"]) {
    if (input[key] !== undefined || opts[key] !== undefined) return `Tracked background assignment cannot combine with ${key}.`
  }
  if ((opts.context !== undefined && opts.context !== "fresh") || opts.acceptance.verify.some(v => object(v) && v.id === "beads-progress")) return "Tracked background work needs fresh context and an unused beads-progress gate ID."
  const root = join(dirname(a.parent), "beads-handoffs", a.event)
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
  const args = ["python3", "-I", script, "background-progress", a.bead, "--session-root", root, "--parent", a.parent, "--parent-actor", a.actor, "--since", a.since, "--event", a.event]
  const check = { id: "beads-progress", command: args.map(quote).join(" "), cwd: a.cwd, env: { BEADS_DIR: a.store, BEADS_DOLT_SHARED_SERVER: "" }, timeoutMs: 35_000 }
  input.options = { ...opts, sessionDir: root, context: "fresh", acceptance: { ...opts.acceptance, verify: [...opts.acceptance.verify, check] } }
}

export function bindHandoff(input: Record<string, unknown>, context: () => { cwd: string; store?: string; parent?: string; actor: string; now: number }, script: string): Assignment | string | undefined {
  if (typeof input.task !== "string") return undefined
  const first = input.task.split("\n", 1)[0]?.trim() ?? ""
  if (!first.startsWith("Bead:")) return undefined
  const bead = /^Bead: ([a-zA-Z0-9][\w.-]{0,199})$/.exec(first)?.[1]
  if (!bead) return "Use Bead: FULL_ID on the first line of the worker task."
  if (typeof input.async !== "boolean" || typeof input.agent !== "string" || input.workflow !== undefined || input.action !== undefined) {
    return "A Bead: assignment requires one subagent and an explicit async setting."
  }
  const { cwd, store, parent, actor, now } = context()
  if (!store || !parent) return "A tracked handoff needs an active coordinator ledger and a persisted parent session."
  const event = randomUUID()
  const assignment: Assignment = { bead, event, cwd, store, parent, actor, since: new Date(Math.floor(now / 1000) * 1000).toISOString() }
  if (input.async) {
    const refusal = installBackgroundCheck(input, assignment, script)
    if (refusal) return refusal
    assignment.background = true
  }
  input.task += `\n\nBefore returning, post a progress checkpoint on ${bead} using this child's Beads actor and event ${event}. Start the comment with beads-work/v1 followed by a space and a JSON object. Set kind to "progress" and event to "${event}". Supply three nonblank strings: result (what happened), evidence (a checkable reference), and next (the next action or owner). Do not close the bead.`
  return assignment
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
