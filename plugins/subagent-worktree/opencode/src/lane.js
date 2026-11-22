/** Pure decision logic for subagent worktree lanes. */
import { wildcardMatch as wildcard } from "@srobroek/opencode-lib/patterns";
import { isSessionNotFound } from "@srobroek/opencode-lib/session-lanes";
import { WORKTREE_PARAM } from "@srobroek/opencode-lib/worktree-param";
export const SUBAGENT_TOOL = "subagent";
export const MERGE_TOOL = "subagent_worktree_merge";
export const LANE_PREFIX = "lane/";
export const SUBAGENT_PREAMBLE = "You are a subagent spawned by another session.";
export { WORKTREE_PARAM, WORKTREE_PARAM_DESCRIPTION } from "@srobroek/opencode-lib/worktree-param";
export const DEFAULT_AGENTS = ["coder", "implementer", "implementer-high", "ui-implementer", "general"];
const MINUTE = 60_000;
function positive(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
export function readOptions(options) {
    const agents = Array.isArray(options?.agents)
        ? options.agents.filter((agent) => typeof agent === "string" && agent !== "")
        : DEFAULT_AGENTS;
    const base = typeof options?.base === "string" && options.base.trim() !== "" ? options.base.trim() : "HEAD";
    const sweep = options?.sweep === "off" || options?.sweep === "prune" ? options.sweep : "report";
    return {
        agents,
        base,
        gates: options?.gates !== false,
        emptyGraceMs: positive(options?.emptyGraceMinutes, 30) * MINUTE,
        sweep,
        minAgeHours: positive(options?.minAgeHours, 24),
        freeBuildDirs: typeof options?.freeBuildDirs === "boolean" ? options.freeBuildDirs : sweep === "prune",
        lowDiskBytes: positive(options?.lowDiskBytes, 0),
        include: Array.isArray(options?.include)
            ? options.include.filter((root) => typeof root === "string" && root !== "")
            : [],
    };
}
export function laneKey(child) {
    return `${LANE_PREFIX}${child}`;
}
export function parseLane(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const lane = value;
    for (const key of ["child", "parent", "projectID", "directory", "branch", "base", "parentDir"]) {
        if (typeof lane[key] !== "string" || lane[key] === "")
            return undefined;
    }
    if (!["active", "removing", "removed", "merged", "landed"].includes(lane.state))
        return undefined;
    if (lane.target !== undefined && typeof lane.target !== "string")
        return undefined;
    if (lane.title !== undefined && typeof lane.title !== "string")
        return undefined;
    return value;
}
export function readSubagentInput(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input))
        return undefined;
    const value = input;
    if (typeof value.agent !== "string" || typeof value.prompt !== "string")
        return undefined;
    const read = {
        agent: value.agent,
        description: typeof value.description === "string" ? value.description : "",
        prompt: value.prompt,
    };
    if (typeof value.sessionID === "string" && value.sessionID !== "")
        read.sessionID = value.sessionID;
    if (value.background === true)
        read.background = true;
    if (value[WORKTREE_PARAM] === false)
        read.worktree = false;
    if (typeof value[WORKTREE_PARAM] === "string" && value[WORKTREE_PARAM].trim() !== "")
        read.worktree = value[WORKTREE_PARAM].trim();
    if (typeof value.model === "string" && value.model.trim() !== "")
        read.model = value.model.trim();
    return read;
}
/** The model a `provider/model[#variant]` string names; undefined for anything else (such as `@role`). */
export function parseModel(text) {
    const slash = text.indexOf("/");
    if (slash <= 0)
        return undefined;
    const rest = text.slice(slash + 1);
    const hash = rest.lastIndexOf("#");
    const id = hash < 0 ? rest : rest.slice(0, hash);
    const variant = hash < 0 ? undefined : rest.slice(hash + 1);
    if (id === "" || variant === "")
        return undefined;
    return { providerID: text.slice(0, slash), id, ...(variant === undefined ? {} : { variant }) };
}
/** The `subagent` input without `worktree`, which the built-in tool does not know. */
export function withoutWorktree(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, WORKTREE_PARAM))
        return input;
    const { [WORKTREE_PARAM]: _, ...rest } = input;
    return rest;
}
/**
 * The checkouts in `git worktree list --porcelain -z` output, skipping bare repositories.
 * Each field ends in NUL and each record in an empty field, so a path or lock reason may hold a
 * newline. Undefined for output in any other shape: a record that does not start with its path,
 * or output cut off before its last record ends.
 */
export function parseWorktrees(porcelain) {
    if (porcelain === "")
        return [];
    const records = porcelain.split("\0\0");
    if (records.pop() !== "")
        return undefined;
    const entries = [];
    for (const record of records) {
        const [first = "", ...fields] = record.split("\0");
        if (!first.startsWith("worktree ") || first === "worktree ")
            return undefined;
        if (fields.includes("bare"))
            continue;
        const directory = first.slice("worktree ".length);
        const ref = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length);
        entries.push(ref ? { directory, branch: ref.replace(/^refs\/heads\//, "") } : { directory });
    }
    return entries;
}
function within(path, directory) {
    const root = directory.replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
}
/** The deepest worktree that contains `path`. */
export function containingWorktree(path, entries) {
    return entries.filter((entry) => within(path, entry.directory)).sort((a, b) => b.directory.length - a.directory.length)[0];
}
/**
 * The worktree a `worktree` argument names: a branch checked out in one, a path inside one
 * (`path`, already resolved and normalized by the caller; the deepest worktree wins), or a
 * worktree's directory name when only one has it. `entries` is undefined outside git.
 */
export function findWorktree(requested, path, entries) {
    if (entries === undefined)
        return { ok: false, reason: `cannot use worktree "${requested}": the caller is not in a git checkout` };
    const name = requested.replace(/^refs\/heads\//, "");
    const byBranch = entries.find((entry) => entry.branch === name);
    if (byBranch)
        return { ok: true, worktree: byBranch };
    const byPath = path === undefined ? undefined : containingWorktree(path, entries);
    if (byPath)
        return { ok: true, worktree: byPath };
    const byName = entries.filter((entry) => entry.directory.replace(/\/+$/, "").split("/").pop() === name);
    if (byName.length === 1 && byName[0])
        return { ok: true, worktree: byName[0] };
    const known = entries.map((entry) => `${entry.directory}${entry.branch ? ` (${entry.branch})` : ""}`).join(", ");
    return {
        ok: false,
        reason: `worktree "${requested}" is not a worktree of this project; pass the path or branch of one of: ${known || "(none)"}`,
    };
}
/**
 * Where a subagent call starts. Without `worktree`, a clean caller gets a fresh
 * worktree when the agent is isolated; dirty tracked files keep it in the caller's
 * directory (child sessions inherit the parent's location). With `worktree`, an isolated
 * agent gets a fresh worktree branched from that worktree, and any other agent runs in it.
 */
export function planStart(facts) {
    const { input, isolation, lookup } = facts;
    if (input.sessionID !== undefined)
        return { kind: "default", ...(resumeWorktreeNote(input) ? { note: RESUME_WORKTREE_NOTE } : {}) };
    if (input.worktree === false)
        return { kind: "default" };
    if (input.worktree === undefined && isolation.isolate && facts.trackedDirty)
        return { kind: "default", note: DIRTY_CHECKOUT_NOTE };
    if (input.worktree === undefined || lookup === undefined)
        return isolation.isolate ? { kind: "isolate", from: facts.parentDir } : { kind: "default" };
    if (!lookup.ok)
        return { kind: "refuse", reason: lookup.reason };
    if (!facts.runnable)
        return { kind: "default" };
    if (isolation.isolate)
        return { kind: "isolate", from: lookup.worktree.directory };
    if (lookup.worktree.directory === facts.current)
        return { kind: "default" };
    return { kind: "move", worktree: lookup.worktree };
}
/**
 * Whether HEAD is unborn: a repository after `git init` and before its first commit.
 * Any other failure (not a repository, corrupt refs, a timeout, a detached HEAD that
 * does not resolve) is not unborn, so the call still fails loudly.
 */
export function isUnbornHead(facts) {
    return facts.head === undefined && Boolean(facts.symbolic) && facts.refs === "";
}
export const UNBORN_NOTE = "subagent-worktree: this repository has no commits yet, so the subagent ran in place without a worktree. Commit once to enable isolation.";
export const RESUME_WORKTREE_NOTE = "subagent-worktree: ignored `worktree` on a resumed session; it keeps its directory.";
export function resumeWorktreeNote(input) {
    return input.sessionID !== undefined && input.worktree !== undefined ? RESUME_WORKTREE_NOTE : undefined;
}
export const DIRTY_CHECKOUT_NOTE = "subagent-worktree: the caller checkout has uncommitted changes to tracked files, so the writer ran in place without a lane. Passing `worktree` forces a lane.";
/** Whether a subagent call should run in a fresh worktree. */
export function decideIsolation(facts) {
    if (facts.tool !== SUBAGENT_TOOL)
        return { isolate: false, reason: "not the subagent tool" };
    const input = facts.input;
    if (!input)
        return { isolate: false, reason: "unreadable input" };
    if (input.sessionID !== undefined)
        return { isolate: false, reason: "continues an existing session" };
    if (input.worktree === false)
        return { isolate: false, reason: "explicit opt-out" };
    if (input.worktree === undefined && facts.projectDir && targetsExternalDirectory(input.prompt, facts.projectDir, facts.homeDir))
        return { isolate: false, reason: "task targets another directory" };
    const names = new Set([input.agent, facts.agent?.id, facts.agent?.name].filter((name) => name !== undefined));
    if (!facts.options.agents.some((agent) => names.has(agent)))
        return { isolate: false, reason: "agent not opted in" };
    if (!facts.agent)
        return { isolate: false, reason: "unknown agent" };
    if (facts.agent.mode === "primary")
        return { isolate: false, reason: "primary agent" };
    if (sessionIsReadOnly(facts.agent.permissions, facts.callerPermissions))
        return { isolate: false, reason: "read-only agent (edit denied)" };
    if (facts.callerIsChild)
        return { isolate: false, reason: "caller is a child session" };
    if (!facts.isGit)
        return { isolate: false, reason: "not a git checkout" };
    return { isolate: true };
}
/** Only explicit working-directory directives count, not incidental absolute file paths. */
export function targetsExternalDirectory(prompt, projectDir, homeDir) {
    const paths = [...prompt.matchAll(/(?:working directory|workdir|repository|repo|checkout|work in|work at)\s*(?:is|:|=)?\s*[`"']?(\/[^\s`"',;]+|~\/[^\s`"',;]+)/gi)]
        .map((match) => match[1]?.replace(/[.)]+$/, ""))
        .filter((path) => path !== undefined)
        .map((path) => path.startsWith("~/") && homeDir ? `${homeDir}/${path.slice(2)}` : path);
    // Ambiguous/multi-repository briefs keep isolation; explicit worktree arguments take precedence.
    return paths.length === 1 && !within(paths[0] ?? "", projectDir);
}
/**
 * Whether an agent's permission rules deny `edit` everywhere. OpenCode uses the last matching
 * rule, so this mirrors evaluating `edit` on `*`. Adapted from hueyexe/opencode-ensemble (MIT).
 */
export function rulesAreReadOnly(rules) {
    if (!Array.isArray(rules))
        return false;
    const match = [...rules].reverse().find((rule) => {
        if (typeof rule?.action !== "string" || typeof rule.resource !== "string")
            return false;
        return wildcard("edit", rule.action) && (rule.resource === "*" || rule.resource === "**");
    });
    return match?.effect === "deny";
}
/**
 * Whether a session cannot edit: its agent's rules, then its own rules (evaluated after, the last
 * matching rule wins), deny `edit` everywhere and no later rule grants `edit` or `write` (allow or
 * ask), even on a scoped path. Conservative: any such grant makes the session a writer.
 */
export function sessionIsReadOnly(agentRules, sessionRules) {
    const rules = [...(Array.isArray(agentRules) ? agentRules : []), ...(Array.isArray(sessionRules) ? sessionRules : [])];
    if (!rulesAreReadOnly(rules))
        return false;
    const denied = rules.findLastIndex((rule) => rule?.effect === "deny" &&
        typeof rule.action === "string" &&
        wildcard("edit", rule.action) &&
        (rule.resource === "*" || rule.resource === "**"));
    return !rules.slice(denied + 1).some((rule) => (rule?.effect === "allow" || rule?.effect === "ask") &&
        typeof rule.action === "string" &&
        (wildcard("edit", rule.action) || wildcard("write", rule.action)));
}
/** A branch-safe slug of a task description. */
export function slug(text, max = 32) {
    const value = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max)
        .replace(/-+$/g, "");
    return value || "task";
}
/** The worktree name, which the worktrunk strategy also uses as the branch name. */
export function worktreeName(description, suffix) {
    return `subagent-${slug(description)}-${suffix}`;
}
export function shortSha(sha) {
    return sha.slice(0, 12);
}
/** The text prepended to the child's first prompt. */
export function notice(lane, fresh) {
    const lines = [
        `You work in an isolated git worktree: ${lane.directory} (branch ${lane.branch}, based on ${shortSha(lane.base)}).`,
        "Run every command and edit every file inside it, not in any other checkout. Commit changes before you finish; do not create empty commits. The parent session reviews and merges your work.",
    ];
    return fresh ? [SUBAGENT_PREAMBLE, ...lines].join("\n") : lines.join("\n");
}
/** The child prompt with the worktree notice prepended. */
export function rewritePrompt(prompt, lane, fresh) {
    const text = fresh && prompt.startsWith(SUBAGENT_PREAMBLE) ? prompt.slice(SUBAGENT_PREAMBLE.length).trimStart() : prompt;
    return `${notice(lane, fresh)}\n\n${text}`;
}
/** The first prompt of a subagent that runs in an existing worktree. */
export function startPrompt(prompt, worktree) {
    const text = prompt.startsWith(SUBAGENT_PREAMBLE) ? prompt.slice(SUBAGENT_PREAMBLE.length).trimStart() : prompt;
    const where = `${worktree.directory}${worktree.branch ? ` (branch ${worktree.branch})` : ""}`;
    return `${SUBAGENT_PREAMBLE}\nYou work in the git worktree ${where}. Run every command and read every file there.\n\n${text}`;
}
export { isSessionNotFound };
const millis = (value) => (typeof value === "number" ? value : undefined);
/** Settle a `session.get` lookup into a ChildState. Anything but a clear answer is unknown. */
export async function childState(lookup, ms, sessionID) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("unknown"), ms);
    });
    const settled = lookup.then((session) => {
        if (typeof session !== "object" || session === null)
            return "unknown";
        const time = session.time;
        if (millis(time?.archived) !== undefined)
            return "archived";
        return isRunning({ busy: millis(time?.busy), idle: millis(time?.idle) }) ? "running" : "idle";
    }, (error) => (isSessionNotFound(error, sessionID) ? "deleted" : "unknown"));
    try {
        return await Promise.race([settled, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * The one removal rule: a lane is released only when its child session is deleted or archived.
 * A running, idle or unknown child (including any failed lookup) keeps the lane on every path.
 * The lane's own checks (clean tree, empty or landed HEAD) still apply on top of this.
 */
export function childReleasesLane(child) {
    return child === "deleted" || child === "archived";
}
/**
 * Whether a lane may be removed when its foreground `subagent` call returns: the call succeeded, the
 * lane is empty and clean, and its child session is deleted or archived. An `error` result alone never
 * removes it (a cancelled call leaves the child running); the sweep applies the rule later.
 */
export function shouldRemove(status, resultStatus, child) {
    if (resultStatus !== "completed" || status === undefined)
        return false;
    if (status.ahead !== 0 || status.dirty)
        return false;
    return childReleasesLane(child);
}
export function diffCommand(lane) {
    return `git -C ${quote(lane.parentDir)} diff ${shortSha(lane.base)}...${lane.branch}`;
}
function quote(path) {
    return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}
/** A lane with no commits whose work exists only as uncommitted changes. */
export function isUncommittedOnly(status) {
    return status.ahead === 0 && status.dirty;
}
export function uncommittedOnly(lane) {
    return `the branch has 0 commits; the work exists only as uncommitted changes in ${lane.directory} and is lost if the worktree is force-removed. Continue the subagent (subagent with sessionID ${lane.child}) and ask it to commit its work.`;
}
/** The lane note appended to the subagent tool result. */
export function annotation(lane, status, removed) {
    const attrs = `branch="${lane.branch}" base="${shortSha(lane.base)}"${lane.target ? ` target="${lane.target}"` : ""}`;
    if (removed) {
        return `<subagent-worktree ${attrs} state="removed">\nNo commits and a clean tree, so the worktree was removed. Continuing this session (sessionID ${lane.child}) gives it a fresh worktree.\n</subagent-worktree>`;
    }
    const lines = [`<subagent-worktree ${attrs} directory="${lane.directory}" state="${lane.state}">`];
    if (status) {
        lines.push(`Commits ahead of base: ${status.ahead}. Uncommitted changes: ${status.dirty ? "yes" : "no"}.`);
        if (isUncommittedOnly(status))
            lines.push(`Warning: ${uncommittedOnly(lane)}`);
    }
    lines.push(`Review: ${diffCommand(lane)}${status?.dirty ? ` (uncommitted: git -C ${quote(lane.directory)} status)` : ""}`);
    lines.push(`Merge: subagent_worktree_merge with sessionID ${lane.child} and method "wt-merge"${lane.target ? ` merges into ${lane.target}` : ""}. Method "none" reports status without merging; "list" reports every active lane.`);
    lines.push("</subagent-worktree>");
    return lines.join("\n");
}
/**
 * `wt merge` argv that merges the lane branch into `target`, keeping its history. `--no-remove` keeps the
 * checkout: the plugin removes it afterwards under the removal lock, and only for a child that is gone.
 */
export function mergeArgs(directory, target) {
    return ["wt", "-C", directory, "merge", target, "--no-squash", "--no-ff", "--no-remove", "--yes"];
}
/** Whether `wt merge` output describes a merge or rebase conflict. */
export function isConflict(output) {
    return /conflict|could not apply|resolve all conflicts|needs merge/i.test(output);
}
/** Files in both lists, sorted. */
export function overlap(laneFiles, localFiles) {
    const local = new Set(localFiles);
    return [...new Set(laneFiles.filter((file) => local.has(file)))].sort();
}
/** Whether a lane can merge now, and into which branch. */
export function decideMerge(input) {
    const { lane } = input;
    if (!lane)
        return { refuse: true, reason: "no worktree lane for this session" };
    if (lane.state !== "active")
        return { refuse: true, reason: `the lane is already ${lane.state}` };
    if (lane.parent !== input.caller)
        return { refuse: true, reason: "only the session that spawned the subagent can merge its lane" };
    const target = input.target ?? lane.target;
    if (!target)
        return { refuse: true, reason: "the lane has no target branch (the caller was on a detached HEAD); pass target" };
    if (!input.status)
        return { refuse: true, reason: `cannot read the worktree at ${lane.directory}` };
    if (isUncommittedOnly(input.status))
        return { refuse: true, reason: uncommittedOnly(lane) };
    if (input.status.dirty) {
        return { refuse: true, reason: `the worktree has uncommitted changes; commit or discard them in ${lane.directory} first` };
    }
    if (input.status.ahead === 0)
        return { refuse: true, reason: "the branch has no commits to merge" };
    if (!input.laneFiles)
        return { refuse: true, reason: `cannot list the files ${lane.branch} changes against ${target}` };
    if (!input.localFiles)
        return { refuse: true, reason: `cannot read the local changes in the ${target} checkout` };
    const files = overlap(input.laneFiles, input.localFiles);
    if (files.length > 0) {
        return {
            refuse: true,
            reason: `the ${target} checkout has uncommitted or untracked changes to files the lane also changes; commit, stash or remove them there first: ${files.join(", ")}`,
        };
    }
    return { refuse: false, target };
}
/** The checkout that has `branch` checked out. */
export function worktreeForBranch(entries, branch) {
    return entries.find((entry) => entry.branch === branch)?.directory;
}
/** How long a session lookup in `method: "list"` may take before it counts as unknown. */
export const SESSION_LOOKUP_MS = 2000;
/** Settle a session lookup: resolved is alive, rejected is gone, and no answer within `ms` is unknown. */
export async function liveness(lookup, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("unknown"), ms);
    });
    try {
        return await Promise.race([lookup.then(() => "alive", () => "gone"), timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Why a lane looks orphaned, or an empty list. */
export function orphanReasons(report) {
    const reasons = [];
    if (report.child === "gone")
        reasons.push("child session gone");
    if (report.parent === "gone")
        reasons.push("parent session gone");
    if (report.status === undefined)
        reasons.push("worktree unreadable");
    return reasons;
}
/** The `method: "list"` report. It never removes anything. */
export function formatLaneList(reports, caller) {
    if (reports.length === 0)
        return `<subagent-worktree-lanes count="0">\nNo active lanes.\n</subagent-worktree-lanes>`;
    const lines = [`<subagent-worktree-lanes count="${reports.length}">`];
    for (const report of reports) {
        const { lane, status } = report;
        const state = status ? `ahead=${status.ahead} dirty=${status.dirty ? "yes" : "no"}` : "ahead=? dirty=?";
        const reasons = orphanReasons(report);
        const owner = lane.parent === caller ? "yours" : `parent ${lane.parent}`;
        lines.push(`- ${lane.branch} (sessionID ${lane.child}, ${owner}) ${lane.directory} ${state} child=${report.child} parent=${report.parent}${reasons.length > 0 ? ` ORPHAN: ${reasons.join(", ")}` : ""}`);
        if (status && isUncommittedOnly(status))
            lines.push(`  Warning: ${uncommittedOnly(lane)}`);
    }
    if (reports.some((report) => orphanReasons(report).length > 0)) {
        lines.push("Orphaned lanes are reported only; nothing was removed. Review them and remove a worktree yourself (wt remove) once its work is merged or no longer needed.");
    }
    lines.push("</subagent-worktree-lanes>");
    return lines.join("\n");
}
/** The last lines of command output, without ANSI codes. */
export function tail(text, lines = 40) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
    const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
    return clean.split("\n").slice(-lines).join("\n");
}
/** Whether the latest execution started and has not ended: it began after the last completed one ended. */
export function isRunning(session) {
    return session.busy !== undefined && (session.idle === undefined || session.busy > session.idle);
}
export const WRITER_LIVENESS_NOTE = "subagent-worktree: could not check whether the worktree already has a live writer session; the spawn went ahead. List your background work first.";
/**
 * Whether a new writer subagent may start in an explicitly named worktree. A live writer is a
 * child session in that directory whose latest execution is still running (an earlier `outcome`
 * does not matter: a resumed session keeps it while it runs again). `sessions` is undefined when the
 * lookup failed or timed out; uncertainty allows the spawn and warns.
 */
export function decideWriterGuard(facts) {
    if (!facts.writer)
        return { kind: "allow" };
    if (facts.sessions === undefined)
        return { kind: "allow", warn: WRITER_LIVENESS_NOTE };
    const live = facts.sessions.find((session) => session.parentID !== undefined && session.id !== facts.caller && !session.readOnly && isRunning(session));
    if (!live)
        return { kind: "allow" };
    return { kind: "refuse", reason: writerRefusal(facts.directory, live.id) };
}
/** The refusal for a second writer; `child` is the session already writing, or undefined while its spawn is still starting. */
export function writerRefusal(directory, child) {
    return child === undefined
        ? `${directory} already has a writer spawn in progress that has not started yet. Wait for it, then send that session a follow-up (pass its sessionID) instead of spawning a second writer, or stop it first.`
        : `${directory} already has a live writer session ${child}. Send that session a follow-up (pass sessionID: "${child}") instead of spawning a second writer, or stop it first.`;
}
/** How long a writer spawn holds its worktree before its child's first execution shows up in `session.list`. */
export const RESERVATION_MS = 60_000;
/** The unexpired reservation that blocks the spawn holding `token`: one held under another token. */
export function blockingReservation(reservation, now, token) {
    return reservation !== undefined && reservation.token !== token && reservation.until > now ? reservation : undefined;
}
/**
 * Where the spawn holding `token` stands after it waited: "held" (its own reservation is live),
 * "free" (the slot is empty or expired, so it may re-take it) or "replaced" (another token holds
 * it, which fences the owner).
 */
export function reservationStatus(reservation, now, token) {
    if (reservation === undefined || reservation.until <= now)
        return "free";
    return reservation.token === token ? "held" : "replaced";
}
export const FENCED_REASON = "another writer spawn took over this worktree while it waited. Check for a live writer session, then spawn again.";
