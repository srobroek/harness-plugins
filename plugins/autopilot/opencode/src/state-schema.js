/** The `state.json` schema, checked at the disk boundary. */
import * as Schema from "effect/Schema";
const Strings = Schema.Array(Schema.String);
const ScopeSchema = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("queue") }),
    Schema.Struct({ kind: Schema.Literal("bead"), id: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("goal"), text: Schema.String }),
]);
const OptionsSchema = Schema.Struct({
    scope: Schema.optionalKey(Schema.String),
    full: Schema.Boolean,
    allow: Schema.Array(Schema.Literals(["merge", "deploy", "self-review"])),
    lanes: Schema.Finite,
    forMs: Schema.optionalKey(Schema.Finite),
    untilTime: Schema.optionalKey(Schema.String),
    until: Schema.optionalKey(Schema.String),
});
const ChildStateSchema = Schema.Struct({
    step: Schema.optionalKey(Schema.Literals(["nudge", "respawn", "park"])),
    stepAt: Schema.optionalKey(Schema.Finite),
    done: Schema.optionalKey(Schema.Boolean),
});
export const RunStateSchema = Schema.Struct({
    version: Schema.Literal(1),
    generation: Schema.Finite,
    runId: Schema.String,
    sessionID: Schema.String,
    directory: Schema.String,
    phase: Schema.Literals(["setup", "running", "stopping", "stopped"]),
    options: OptionsSchema,
    scope: ScopeSchema,
    ledger: Schema.optionalKey(Schema.String),
    createdAt: Schema.Finite,
    armedAt: Schema.optionalKey(Schema.Finite),
    deadline: Schema.optionalKey(Schema.Finite),
    tick: Schema.Struct({
        kind: Schema.Literals(["none", "automation", "fallback"]),
        automationId: Schema.optionalKey(Schema.String),
        token: Schema.optionalKey(Schema.String),
    }),
    ticks: Schema.Finite,
    idleTicks: Schema.Finite,
    beads: Schema.Struct({ open: Strings, ready: Strings, blocked: Strings, inProgress: Strings, closed: Strings }),
    commits: Schema.Finite,
    journalLength: Schema.Finite,
    finishedChildren: Schema.Finite,
    attempts: Schema.Record(Schema.String, Schema.Finite),
    children: Schema.Record(Schema.String, ChildStateSchema),
    parked: Strings,
    worktrees: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String, real: Schema.String, dev: Schema.String, ino: Schema.String }))),
    stopRequested: Schema.optionalKey(Schema.Boolean),
    stopReason: Schema.optionalKey(Schema.String),
    stoppedAt: Schema.optionalKey(Schema.Finite),
    stop: Schema.optionalKey(Schema.Struct({
        journalLength: Schema.Finite,
        summary: Schema.Boolean,
        handoff: Schema.optionalKey(Schema.String),
    })),
});
const decode = Schema.decodeUnknownExit(RunStateSchema);
/** `value` as a run state, or why it is not one. */
export function decodeRunState(value) {
    const exit = decode(value);
    if (exit._tag === "Success")
        return { ok: true, state: exit.value };
    return { ok: false, reason: String(exit.cause).replace(/\s+/g, " ").slice(0, 300) };
}
