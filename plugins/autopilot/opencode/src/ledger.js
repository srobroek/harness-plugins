/**
 * Which beads ledger (`.beads` directory) a run owns. The decisions are pure; the file system is
 * behind `LedgerHost`, so tests drive them without a disk.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sessionPinFor } from "@srobroek/opencode-lib/beads-store";
import { readBounded } from "@srobroek/opencode-lib/bounded-read";
/**
 * `routes.jsonl` as prefix -> path. A prefix must end in `-`; an entry without it matches nothing,
 * so it is dropped, not repaired. `path` is relative to the directory that holds the `.beads`.
 */
export function parseRoutes(text) {
    const routes = new Map();
    for (const line of text.split("\n")) {
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            continue;
        }
        const { prefix, path } = (value ?? {});
        if (typeof prefix === "string" && prefix.endsWith("-") && typeof path === "string" && path !== "")
            routes.set(prefix, path);
    }
    return routes;
}
const unreadable = (file, ledger) => ({ ok: false, error: `${file} in ${ledger} cannot be read safely (a symlink, a special file or too large), so routing cannot be checked; fix it or pass setup.ledger` });
/**
 * Follow `ledger`'s `redirect` file as bd does: the first line that is not blank or a comment names
 * the target, relative to the directory that holds the `.beads`. One level only; a target that is
 * no ledger leaves `ledger` as it is. A redirect that cannot be read is an error, never "no redirect".
 */
export function followRedirect(ledger, host) {
    const read = host.readRedirect(ledger);
    if (read.kind === "absent")
        return { ok: true, ledger };
    if (read.kind === "unreadable")
        return unreadable("redirect", ledger);
    const line = read.text.split("\n").map((entry) => entry.trim()).find((entry) => entry !== "" && !entry.startsWith("#"));
    if (line === undefined)
        return { ok: true, ledger };
    const target = host.canonical(isAbsolute(line) ? line : resolve(dirname(ledger), line));
    return { ok: true, ledger: host.isLedger(target) ? target : ledger };
}
/**
 * The ledger the routes of `ledger` assign to `id` (the longest matching prefix wins), `ledger: null`
 * when none does. A route that leads nowhere, or a routes file or redirect that cannot be read, is an
 * error. Only `ledger`'s own `routes.jsonl` is read; parent directories are never searched. The
 * target is followed through its own redirect.
 */
function routedLedger(ledger, id, host) {
    const read = host.readRoutes(ledger);
    if (read.kind === "absent")
        return { ok: true, ledger: null };
    if (read.kind === "unreadable")
        return unreadable("routes.jsonl", ledger);
    let best;
    for (const [prefix, path] of parseRoutes(read.text))
        if (id.startsWith(prefix) && (best === undefined || prefix.length > best.prefix.length))
            best = { prefix, path };
    if (best === undefined)
        return { ok: true, ledger: null };
    const target = host.canonical(join(resolve(dirname(ledger), best.path), ".beads"));
    if (!host.isLedger(target))
        return { ok: false, error: `the route for ${id} in ${ledger} leads to no ledger (${target})` };
    const followed = followRedirect(target, host);
    return followed;
}
/**
 * The ledger a run arms on: the explicit one (a ledger directory or the checkout holding it), else
 * the one a bead scope's prefix routes to, else the session directory's. Never a guess: an explicit
 * path or a route that is no ledger refuses.
 */
export function resolveLedger(input, host) {
    if (input.explicit !== undefined && input.explicit.trim() !== "") {
        const path = resolve(input.directory, input.explicit.trim());
        for (const candidate of [path, join(path, ".beads")])
            if (host.isLedger(candidate))
                return followRedirect(host.canonical(candidate), host);
        return { ok: false, error: `setup.ledger ${input.explicit} is not a beads ledger (a .beads directory, or the checkout that holds one)` };
    }
    const session = host.sessionLedger(input.directory);
    if (session === undefined)
        return { ok: false, error: `no beads ledger found for ${input.directory}; pass setup.ledger` };
    const resolved = followRedirect(host.canonical(session), host);
    if (!resolved.ok || input.scope.kind !== "bead")
        return resolved;
    const routed = routedLedger(resolved.ledger, input.scope.id, host);
    if (!routed.ok)
        return routed;
    return { ok: true, ledger: routed.ledger ?? resolved.ledger };
}
/** Why a write naming `beadId` would leave `ledger`, or `undefined` when it stays. */
export function foreignBead(ledger, beadId, host) {
    const routed = routedLedger(ledger, beadId, host);
    if (!routed.ok)
        return routed.error;
    if (routed.ledger === null || routed.ledger === ledger)
        return undefined;
    return `${beadId} belongs to ${routed.ledger}, not this run's ledger ${ledger}`;
}
/** The environment a `bd` run for `ledger` gets: its ledger, whatever the session inherited. */
export const ledgerEnv = (ledger) => ({ BEADS_DIR: ledger });
const isDir = (path) => {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
};
/** The real file system. */
export const fsLedgerHost = {
    sessionLedger: (directory) => sessionPinFor(directory),
    isLedger: (path) => isAbsolute(path) && isDir(path) && (isDir(join(path, "embeddeddolt")) || readBounded(join(path, "metadata.json")).kind === "text" || readBounded(join(path, "config.yaml")).kind === "text" || readBounded(join(path, "redirect")).kind === "text"),
    canonical: (path) => {
        try {
            return realpathSync(path);
        }
        catch {
            return resolve(path);
        }
    },
    readRoutes: (ledger) => readBounded(join(ledger, "routes.jsonl")),
    readRedirect: (ledger) => readBounded(join(ledger, "redirect")),
};
