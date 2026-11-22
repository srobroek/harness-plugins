import { readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { commandWords } from "@srobroek/opencode-lib/command-words";
import { scanShell } from "@srobroek/opencode-lib/shell-command";
import { appendResultText } from "@srobroek/opencode-lib/shell-result";
import { shellWriteTargets } from "@srobroek/opencode-lib/shell-write-targets";
import { shellCall, writeTargets } from "@srobroek/opencode-lib/tool-targets";
import { onSessionDeleted } from "./session-cache.ts";
import { commandScripts, controlWords } from "./shell-scripts.ts";
export function scratchEntry(target, cwd, root) {
    const rel = relative(root, resolve(cwd, target));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        return undefined;
    return join(root, rel.split(sep)[0]);
}
export function scratchEntries(tool, input, cwd, root) {
    const call = shellCall(tool, input);
    const dir = call?.workdir ? resolve(cwd, call.workdir) : cwd;
    const targets = call ? scratchCommandTargets(call.command, dir) : writeTargets(tool, input);
    return [...new Set(targets.flatMap((target) => {
            if (/[$`]/.test(target))
                return [];
            const entry = scratchEntry(target, dir, root);
            return entry ? [entry] : [];
        }))];
}
export function scratchCommandTargets(command, cwd, depth = 0) {
    if (depth > 32)
        return [];
    const scripts = new Map();
    const discover = (source, nested) => {
        if (nested > 32)
            return;
        const scan = scanShell(source, { executableSubstitutionsOnly: true });
        for (const item of scan.items) {
            if (item.kind !== "command")
                continue;
            const { argv } = commandWords(controlWords(item.words.map((word) => word.value)));
            const key = JSON.stringify(argv);
            scripts.set(key, [...(scripts.get(key) ?? []), ...commandScripts(argv, item.hereDocuments)]);
        }
        for (const substitution of scan.substitutions)
            discover(substitution, nested + 1);
    };
    discover(command, depth);
    return shellWriteTargets(command, cwd, (argv, dir) => {
        const targets = scratchShellWrites(argv, dir);
        if (dir !== null) {
            for (const source of new Set([...commandScripts(argv), ...(scripts.get(JSON.stringify(argv)) ?? [])])) {
                targets.push(...scratchCommandTargets(source, dir, depth + 1));
            }
        }
        return targets;
    }, controlWords);
}
export function scratchShellWrites(argv, cwd) {
    const targets = [];
    const name = argv[0]?.split("/").pop();
    const args = argv.slice(1);
    if (name === "mkdir") {
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "-m" || args[i] === "--mode")
                i++;
            else if (!args[i]?.startsWith("-"))
                targets.push(args[i]);
        }
    }
    if (name === "mktemp") {
        let base = cwd;
        let template;
        let temporaryDirectory = false;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === "-p" || arg === "--tmpdir") {
                const directory = args[++i] ?? "";
                base = isAbsolute(directory) ? directory : cwd === null ? null : resolve(cwd, directory);
                temporaryDirectory = true;
            }
            else if (arg.startsWith("--tmpdir=")) {
                const directory = arg.slice(9);
                base = isAbsolute(directory) ? directory : cwd === null ? null : resolve(cwd, directory);
                temporaryDirectory = true;
            }
            else if (!arg.startsWith("-"))
                template = arg;
        }
        if (template && isAbsolute(template))
            targets.push(template);
        else if (base !== null && (template || temporaryDirectory))
            targets.push(resolve(base, template ?? "tmp.XXXXXXXXXX"));
    }
    return targets;
}
function entries(root) {
    try {
        return readdirSync(root).map((entry) => join(root, entry));
    }
    catch {
        return [];
    }
}
export function newScratchEntries(candidates, before, after, noted) {
    const matches = (candidate, entry) => {
        if (candidate === entry)
            return true;
        const pattern = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/X{4,}/g, (xs) => `[A-Za-z0-9]{${xs.length}}`);
        return new RegExp(`^${pattern}$`).test(entry);
    };
    return after.filter((entry) => !before.has(entry) && !noted.has(entry) && candidates.some((candidate) => matches(candidate, entry))).slice(0, Math.max(0, 3 - noted.size));
}
export async function setupScratch(ctx) {
    const root = join(realpathSync(tmpdir()), "opencode");
    const children = new Map();
    const pending = new Map();
    const noted = new Map();
    const stop = onSessionDeleted(ctx, (sessionID) => {
        children.delete(sessionID);
        noted.delete(sessionID);
        for (const [id, call] of pending)
            if (call.sessionID === sessionID)
                pending.delete(id);
    });
    const before = await ctx.tool.hook("execute.before", async (event) => {
        let child = children.get(event.sessionID);
        if (!child) {
            child = ctx.session.get({ sessionID: event.sessionID }).then((session) => typeof session.parentID === "string" ? session.location.directory : undefined).catch(() => undefined);
            children.set(event.sessionID, child);
        }
        const cwd = await child;
        if (cwd === undefined || children.get(event.sessionID) !== child)
            return;
        const candidates = scratchEntries(event.tool, event.input, cwd, root);
        if (candidates.length)
            pending.set(event.id, { sessionID: event.sessionID, candidates, existed: new Set(entries(root)) });
    });
    const after = await ctx.tool.hook("execute.after", (event) => {
        const saved = pending.get(event.id);
        pending.delete(event.id);
        if (!saved || event.status !== "completed")
            return;
        const seen = noted.get(saved.sessionID) ?? new Set();
        noted.set(saved.sessionID, seen);
        for (const entry of newScratchEntries(saved.candidates, saved.existed, entries(root), seen)) {
            seen.add(entry);
            event.result = appendResultText(event.result, `Scratch: you created ${entry}. Delete it before your final report unless your brief says to keep it.`);
        }
    });
    return async () => {
        await stop();
        await after.dispose();
        await before.dispose();
        children.clear();
        pending.clear();
        noted.clear();
    };
}
