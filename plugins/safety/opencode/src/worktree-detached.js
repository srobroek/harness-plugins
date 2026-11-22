/**
 * Refuse a worktree removal that would leave a commit unreachable, and report what a
 * forced removal would discard.
 *
 * Ported from omp-plugins (`safety/extensions/worktree-detached-guard.ts`). `wt remove`
 * and `git worktree remove` delete a checkout whose HEAD is detached and report only
 * "no branch to delete": the tip loses its last reference and survives solely as an
 * unreferenced object until it is collected. This gate measures containment and refuses
 * the removal when nothing else reaches the tip. A removal that names several targets,
 * or whose targets come from a wrapper or an expansion, is refused as well.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { budget, gitOut, ProbeTimeout } from "./probes.ts";
import { base, gitInvocation, hasFlag, positionals, walkShell, wtInvocation } from "./shell.ts";
const MAX_COMMAND_LENGTH = 64_000;
const PREFIX = "Worktree removal refused";
/** Wrappers that carry a command as text this gate cannot read. */
const OPAQUE = new Set(["ssh", "parallel"]);
const REMOVAL_TEXT = /(?:^|[\s;&|'"])(?:wt|worktrunk)\s+(?:remove|rm)\b|worktree\s+(?:remove|rm)\b/;
/** Flags that take a separate value, so the value is never a removal target. */
const VALUE_FLAGS = new Set([
    "-C",
    "--config",
    "--git-dir",
    "--work-tree",
    "--reason",
    "--repo",
    "--format",
]);
function joinChdirs(chdirs) {
    if (chdirs.length === 0)
        return null;
    return chdirs.reduce((at, next) => (isAbsolute(next) ? next : join(at, next)));
}
/** Recognise worktree removals in a command. */
export function removals(command) {
    const found = [];
    const walk = walkShell(command);
    for (const item of walk.commands) {
        if (OPAQUE.has(base(item.argv[0])) && REMOVAL_TEXT.test(item.argv.slice(1).join(" "))) {
            found.push({ tool: "wt", chdir: null, targets: [], force: false, literal: false });
            continue;
        }
        const git = gitInvocation(item.argv);
        const wt = git ? undefined : wtInvocation(item.argv);
        const isGit = git?.subcommand === "worktree" && (git.args[0] === "remove" || git.args[0] === "rm");
        const isWt = wt !== undefined && (wt.subcommand === "remove" || wt.subcommand === "rm");
        if (!isGit && !isWt)
            continue;
        const args = isGit ? (git?.args.slice(1) ?? []) : (wt?.args ?? []);
        const tool = isGit ? "git" : "wt";
        const force = hasFlag(args, "f", ["--force"]);
        const trusted = item.context === "top" && item.words !== undefined && !item.words.some((word) => word.expands);
        if (!trusted) {
            found.push({ tool, chdir: null, targets: [], force, literal: false });
            continue;
        }
        const chdir = joinChdirs(isGit ? (git?.chdirs ?? []) : (wt?.chdirs ?? []));
        found.push({ tool, chdir, targets: positionals(args, VALUE_FLAGS), force, literal: true });
    }
    return found;
}
export function parseWorktreeList(porcelain) {
    const records = [];
    let current = null;
    for (const line of porcelain.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (current)
                records.push(current);
            current = { path: line.slice("worktree ".length), head: "", detached: false, branch: "" };
            continue;
        }
        if (!current)
            continue;
        if (line.startsWith("HEAD "))
            current.head = line.slice("HEAD ".length);
        else if (line.startsWith("branch "))
            current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        else if (line.trim() === "detached")
            current.detached = true;
    }
    if (current)
        records.push(current);
    return records;
}
function matchTarget(target, cwd, worktrees, probe) {
    const resolved = probe.resolve(cwd, target);
    const byPath = worktrees.find((w) => probe.resolve(cwd, w.path) === resolved);
    if (byPath)
        return byPath;
    const named = worktrees.filter((w) => base(w.path) === target || w.branch === target);
    return named.length === 1 ? named[0] : null;
}
/** The verdict one removal earns. */
export async function reviewRemoval(removal, cwd, probe) {
    if (!removal.literal) {
        return {
            refuse: `${PREFIX}: this call builds its targets through a wrapper or shell expansion, so the checkouts it would delete cannot be identified. Name each worktree path literally, one removal per call.`,
        };
    }
    if (removal.targets.length > 1) {
        return {
            refuse: `${PREFIX}: ${removal.targets.length} targets in one call (${removal.targets.join(", ")}). One removal per call keeps each checkout's containment evidence auditable.`,
        };
    }
    // `wt remove` without a target removes the current worktree; `git worktree remove` requires one.
    const target = removal.targets[0] ?? (removal.tool === "wt" ? "." : undefined);
    if (target === undefined)
        return null;
    const at = removal.chdir ? probe.resolve(cwd, removal.chdir) : cwd;
    const worktrees = await probe.list(at);
    if (worktrees === null) {
        return {
            refuse: `${PREFIX}: \`git worktree list\` did not answer, so this call cannot prove the checkout's tip stays reachable. Re-run it where the repository is readable.`,
        };
    }
    const record = matchTarget(target, at, worktrees, probe);
    if (!record)
        return null;
    if (record.detached) {
        const refs = await probe.containingRefs(at, record.head);
        const rescue = `git branch recovered/${base(record.path)} ${record.head}`;
        if (refs === null)
            return {
                refuse: `${PREFIX}: ${target} is detached at ${record.head} and its containment could not be determined. Mint a rescue ref first: ${rescue}`,
            };
        if (refs.length === 0)
            return {
                refuse: `${PREFIX}: ${target} is detached at ${record.head} and no ref reaches that commit, so removing the checkout orphans it — git reports only "no branch to delete". Mint a rescue ref first: ${rescue}`,
            };
    }
    if (!removal.force)
        return null;
    const status = await probe.status(record.path);
    if (status !== null && status.length === 0)
        return null;
    const what = status === null
        ? "its status could not be read"
        : `it has ${status.length} uncommitted or untracked path${status.length === 1 ? "" : "s"}:\n${status
            .slice(0, 10)
            .map((line) => `    ${line}`)
            .join("\n")}${status.length > 10 ? `\n    … and ${status.length - 10} more` : ""}`;
    return {
        ask: `Forced removal of worktree ${record.path} (${record.branch || `detached at ${record.head}`}) discards changes that exist nowhere else: ${what}\n  Commit or stash them first, or drop --force so git refuses a dirty checkout.`,
    };
}
export function defaultProbe(bounds = {}) {
    const run = budget(bounds).run;
    return {
        list: async (cwd) => {
            const out = await gitOut(run, ["worktree", "list", "--porcelain"], cwd);
            return out === null ? null : parseWorktreeList(out);
        },
        containingRefs: async (cwd, sha) => {
            if (!/^[0-9a-f]{7,64}$/.test(sha))
                return null;
            const out = await gitOut(run, ["for-each-ref", "--contains", sha, "--count=1", "--format=%(refname)"], cwd);
            return out === null ? null : out.split("\n").filter((line) => line.trim() !== "");
        },
        status: async (cwd) => {
            const out = await gitOut(run, ["status", "--porcelain"], cwd);
            return out === null ? null : out.split("\n").filter((line) => line.trim() !== "");
        },
        resolve: (cwd, target) => {
            const absolute = resolve(cwd, target);
            try {
                // Worktree paths and command arguments reach the same checkout through symlinks
                // (macOS /tmp is one), so containment must compare resolved paths.
                return realpathSync(absolute);
            }
            catch {
                return absolute;
            }
        },
    };
}
/** Every verdict a shell command's worktree removals earn; a refusal ends the list. */
export async function reviewRemovals(command, cwd, probe = defaultProbe(), parse = removals) {
    const mayContainRemoval = (command.includes("remove") || command.includes(" rm")) &&
        (command.includes("worktree") || /(^|[^\w/-])(wt|worktrunk)([^\w-]|$)/.test(command));
    if (!mayContainRemoval)
        return { ask: [] };
    if (command.length > MAX_COMMAND_LENGTH) {
        return {
            refuse: `${PREFIX}: command exceeds the 64 KiB safety limit (oversize), so its removal cannot be checked.`,
            ask: [],
        };
    }
    const ask = [];
    try {
        for (const removal of parse(command)) {
            const verdict = await reviewRemoval(removal, cwd, probe);
            if (verdict === null)
                continue;
            if ("refuse" in verdict)
                return { refuse: verdict.refuse, ask };
            ask.push(verdict.ask);
        }
    }
    catch (error) {
        if (error instanceof ProbeTimeout) {
            ask.push(`\`${error.message}\` timed out, so this call cannot prove the removed checkout's tip stays reachable or its changes are committed.`);
            return { ask };
        }
        return {
            refuse: `${PREFIX}: parse failure while checking a removal command; its impact could not be proved.`,
            ask,
        };
    }
    return { ask };
}
