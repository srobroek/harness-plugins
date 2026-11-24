/**
 * The tools' names, descriptions and input schemas, which every host registers unchanged. The
 * schemas are plain JSON Schema: OpenCode takes them as they are, and pi validates any JSON
 * Schema.
 */

import { GRANTS, type Grant } from "./args.ts"
import { MERGE_METHODS } from "./policy.ts"

export const STATUS_DESCRIPTION =
  "Autopilot run state: rebuilds it from beads, git, child sessions and the journal, evaluates stop conditions.\n" +
  'action "status" (default) reports; "arm" ends setup with the answered values and returns the tick automation to create; ' +
  '"tick" is what the automation calls; "fallback" starts the in-process timer when automation_create failed; "stop" ends the run, writes summary.md and the handoff bead.'

/** The status description where the plugin's own timer ticks the run (pi has no automations). */
export const TIMER_STATUS_DESCRIPTION =
  "Autopilot run state: rebuilds it from beads, git and the journal, evaluates stop conditions.\n" +
  'action "status" (default) reports; "arm" ends setup with the answered values and starts the 4-minute tick; ' +
  '"tick" is what the tick calls; "fallback" restarts the tick; "stop" ends the run, writes summary.md and the handoff bead.'

export const LOG_DESCRIPTION = "Append one validated entry (decision, blocker, issue, ambiguity, stop, progress, action) to the autopilot journal."

export const MERGE_DESCRIPTION =
  "Merge one PR at one reviewed head, under --allow merge.\n" +
  "Requires an approval for the exact SHA and green checks; merges only if the head is still that SHA."

export const EXPORT_REVIEW_DESCRIPTION =
  "Export a review round for reviewers that cannot run git while the run is armed.\n" +
  "Writes the base...head diff, a diffstat, the changed files at head and a hash manifest under the run's review directory; give reviewers the returned dir and manifestHash."

export const REVIEW_DESCRIPTION =
  "Start a plugin-run review of one PR head by a code-reviewer session; returns at once.\n" +
  "Under --allow self-review a merge may rest on its APPROVE for that exact head; autopilot_status reports the verdict."

export const COMMAND_DESCRIPTION = "Run this session unattended: /autopilot [scope] [flags] | resume | review | stop"

export const STATUS_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["status", "arm", "tick", "fallback", "stop"] },
    run: { type: "string", description: "run id; default this session's run" },
    setup: {
      type: "object",
      description: "arm: answers from the setup round",
      additionalProperties: false,
      properties: {
        scope: { type: "string" },
        ledger: { type: "string", description: "the beads ledger (.beads directory) this run reads and writes; default: derived from the scope or the session directory" },
        full: { type: "boolean" },
        allow: { type: "array", items: { type: "string", enum: [...GRANTS] } },
        lanes: { type: "integer", minimum: 1 },
        for: { type: "string", description: "duration such as 3h" },
        until_time: { type: "string", description: "HH:MM" },
        until: { type: "string" },
      },
    },
    automation_id: { type: "string", description: "arm: the created automation id" },
    reason: { type: "string", description: "stop: why" },
    token: { type: "string", description: "tick: the automation's binding token" },
    session: { type: "string", description: "tick: the session the automation was created for" },
  },
} as const

export const MERGE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["pr", "sha", "method"],
  properties: {
    pr: { type: ["integer", "string"], description: "PR number" },
    method: { type: "string", enum: [...MERGE_METHODS], description: "the repository's merge method; the repo must allow it" },
    sha: { type: "string", description: "the full 40-digit head commit that was reviewed" },
  },
} as const

export const REVIEW_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["pr", "sha"],
  properties: {
    pr: { type: ["integer", "string"], description: "PR number" },
    sha: { type: "string", description: "the full 40-digit head commit to review" },
  },
} as const

export const EXPORT_REVIEW_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["pr", "base", "head"],
  properties: {
    pr: { type: ["integer", "string"], description: "PR number the round belongs to; keys the stored manifest hash" },
    base: { type: "string", description: "the revision the round is reviewed against, such as main or a SHA" },
    head: { type: "string", description: "the revision under review, such as a branch or a SHA" },
  },
} as const

export type StatusInput = {
  action?: "status" | "arm" | "tick" | "fallback" | "stop"
  run?: string
  setup?: { scope?: string; ledger?: string; full?: boolean; allow?: Grant[]; lanes?: number; for?: string; until_time?: string; until?: string }
  automation_id?: string
  reason?: string
  token?: string
  session?: string
}

export type MergeInput = { pr?: unknown; sha?: unknown; method?: unknown }
export type ReviewInput = { pr?: unknown; sha?: unknown }
export type ExportReviewInput = { pr?: unknown; base?: unknown; head?: unknown }
