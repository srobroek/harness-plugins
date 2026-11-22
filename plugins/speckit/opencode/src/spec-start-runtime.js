import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { embeddedStoreFor, withEmbeddedWriteLock } from "@srobroek/opencode-lib/bd-embedded-write-lock";
import { payload, startSpec } from "./spec-start.ts";
export const BEADS_LOCK = { embeddedStoreFor, withEmbeddedWriteLock };
/**
 * Each bounded `bd` command gets its own bound, sized for a cold embedded store, where one
 * read alone can take 30-50 s; it matches the Beads runner's bound for one-bead writes.
 * `mol pour` and `gate resolve` get no timer, because killing them partway leaves a
 * half-built run; only the caller's abort signal stops them.
 */
export const COMMAND_MS = 120_000;
const UNBOUNDED = new Set(["mol pour", "gate resolve"]);
/** How long a stopped `bd` gets after SIGTERM before SIGKILL, as the Beads runner allows. */
const TERMINATION_GRACE_MS = 5_000;
/** A start stopped by its store-lock wait, a command bound, or cancellation: never a half-done success. */
export class IncompleteStart extends Error {
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
        this.name = "IncompleteStart";
    }
}
export async function runSpecStart(options, signal, commandMs = COMMAND_MS, module = BEADS_LOCK, timers = globalThis) {
    const started = Date.now();
    const cwd = realpathSync(options.workspace);
    const env = {
        ...process.env,
        BEADS_DIR: realpathSync(join(cwd, ".beads")),
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS: "/usr/bin/false",
        SSH_ASKPASS_REQUIRE: "force",
        PAGER: "cat",
        GIT_PAGER: "cat",
        BD_NON_INTERACTIVE: "1",
        BD_NO_PAGER: "1",
    };
    delete env.BEADS_DOLT_SHARED_SERVER;
    if (!module.embeddedStoreFor(cwd, env))
        throw new Error("Canonical embedded store unavailable; no unserialised bd mutation is allowed");
    const completedSteps = [];
    let root = options.root;
    const incomplete = (step, why) => {
        const details = {
            status: "INCOMPLETE",
            step,
            elapsedMs: Date.now() - started,
            completedSteps: [...completedSteps],
            ...(root === undefined ? {} : { root }),
        };
        if (!completedSteps.length && why === "cancelled before")
            return new IncompleteStart(`Workflow start cancelled before \`${step}\`. No workflow-start command ran.`, details);
        const pour = completedSteps.includes("mol pour")
            ? `the pour completed${root === undefined ? "" : ` (root ${root})`}`
            : step === "mol pour"
                ? "a pour was issued and may be partial"
                : "no pour was issued";
        const ran = completedSteps.length ? `Completed: ${completedSteps.join(", ")}` : "No earlier command completed";
        return new IncompleteStart(`Workflow start incomplete: ${why} \`${step}\`. ${ran}; ${pour}. Inspect the run before retrying.`, details);
    };
    const command = (args) => {
        const step = args[0] === "mol" || args[0] === "gate" ? `${args[0]} ${args[1]}` : String(args[0]);
        if (signal?.aborted)
            return Promise.reject(incomplete(step, "cancelled before"));
        const { promise, resolve: resolveResult, reject } = Promise.withResolvers();
        const child = spawn("bd", [...args, "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stopped;
        let grace;
        // The runtime is shared with the CLI, so no handler ctx timers exist here: the raw
        // timers below only ever call kill, which is wrapped because a throw from a timer
        // callback would surface as an uncaughtException in the session.
        const kill = (name) => {
            try {
                child.kill(name);
            }
            catch {
                /* bd already exited; its close event settles the call. */
            }
        };
        const stop = (why) => {
            if (stopped !== undefined)
                return;
            stopped = why;
            kill("SIGTERM");
            grace = timers.setTimeout(() => kill("SIGKILL"), TERMINATION_GRACE_MS);
        };
        const bound = UNBOUNDED.has(step)
            ? undefined
            : timers.setTimeout(() => stop(`${commandMs / 1000} s bound reached during`), commandMs);
        const cancel = () => stop("cancelled during");
        signal?.addEventListener("abort", cancel, { once: true });
        const settle = () => {
            timers.clearTimeout(bound);
            timers.clearTimeout(grace);
            signal?.removeEventListener("abort", cancel);
        };
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (bytes) => {
            stdout += bytes.toString();
        });
        child.stderr.on("data", (bytes) => {
            stderr += bytes.toString();
        });
        child.on("error", (error) => {
            settle();
            reject(error);
        });
        // Settled only once bd has exited, so the store lock is never handed on while it still writes.
        child.on("close", (code) => {
            settle();
            if (stopped !== undefined) {
                reject(incomplete(step, stopped));
                return;
            }
            if (code !== 0) {
                reject(new Error(stderr.trim() || `Beads command exited ${code}; inspect the run before retrying`));
                return;
            }
            completedSteps.push(step);
            if (args[0] !== "query" && args[0] !== "show" && args[0] !== "mol") {
                resolveResult(undefined);
                return;
            }
            let value;
            try {
                value = JSON.parse(stdout);
            }
            catch {
                reject(new Error("Beads returned invalid JSON; inspect the run before retrying"));
                return;
            }
            const poured = step === "mol pour" ? payload(value) : undefined;
            if (poured && typeof poured === "object" && "new_epic_id" in poured && typeof poured.new_epic_id === "string")
                root = poured.new_epic_id;
            resolveResult(value);
        });
        return promise;
    };
    // One hold of the store's write lock spans lookup, pour, and metadata writes, so a
    // concurrent start for this workspace waits and then finds the root this one created.
    // The wait uses the Beads default bound; the signal abandons it.
    const owner = `speckit-start/${options.spec ?? options.root}/${randomUUID()}`;
    const held = await module.withEmbeddedWriteLock(cwd, owner, () => startSpec(options, command), env, undefined, signal);
    if (held.kind === "failed")
        throw new IncompleteStart(`${held.reason} No workflow-start command ran.`, {
            status: "INCOMPLETE",
            step: "store lock",
            elapsedMs: Date.now() - started,
            completedSteps: [],
        });
    return held.value;
}
