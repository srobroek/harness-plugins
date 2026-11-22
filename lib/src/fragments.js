/**
 * Build-time prompt fragments shared between shipped agents.
 *
 * A plugin keeps an agent's source as `agents.src/<id>.md`; `scripts/build.ts` composes it
 * into the committed `agents/<id>.md` the plugin registers. A line that is exactly
 * `{{include <name>}}` becomes every part of `plugins/lib/src/<name>.md`, and
 * `{{include <name>: <part> ...}}` the named parts in the order given. A fragment file is a
 * leading comment for maintainers, never included, then parts that each start with a
 * `<!-- part: <part> -->` line.
 *
 * `{{include shared/<id>}}` inlines `shared/agents/<id>.md` at the repository root: the body
 * of an agent that several plugins ship, each with its own frontmatter. That body may itself
 * include `lib/src` fragments, which are expanded in turn; other fragments do not nest.
 *
 * In the frontmatter, a comment line `# {{rules read-only-shell}}` inside `permissions:` becomes
 * the shell rules of `read-only-shell.ts`, indented like the comment. The source stays valid YAML.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { READ_ONLY_SHELL_RULES } from "./read-only-shell.ts";
export const FRAGMENTS_DIR = fileURLToPath(new URL(".", import.meta.url));
export const SHARED_AGENTS_DIR = fileURLToPath(new URL("../../shared/agents/", import.meta.url));
const SHARED_PREFIX = "shared/";
const INCLUDE = /^\{\{include ((?:shared\/)?[a-z][\w-]*)(?::([ \w-]*))?\}\}[ \t]*$/;
const PART = /^<!-- part: ([a-z][\w-]*) -->[ \t]*$/;
const RULES_LINE = /^([ \t]*)# \{\{rules read-only-shell\}\}[ \t]*$/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
/** The parts of a fragment file, in file order. Throws on a fragment without parts or with a repeated part. */
export function fragmentParts(name, text) {
    const parts = new Map();
    let current;
    for (const line of text.split(/\r?\n/)) {
        const part = PART.exec(line);
        if (part) {
            const id = part[1];
            if (parts.has(id))
                throw new Error(`fragment ${name}: part ${id} appears twice`);
            current = [];
            parts.set(id, current);
        }
        else
            current?.push(line);
    }
    if (parts.size === 0)
        throw new Error(`fragment ${name}: no <!-- part: ... --> lines`);
    return new Map([...parts].map(([id, lines]) => [id, lines.join("\n").trim()]));
}
/** Read fragment `name` from `directory`. */
export function readFragment(name, directory = FRAGMENTS_DIR) {
    const file = name.startsWith(SHARED_PREFIX) ? join(SHARED_AGENTS_DIR, `${name.slice(SHARED_PREFIX.length)}.md`) : join(directory, `${name}.md`);
    if (!existsSync(file))
        throw new Error(`no fragment ${name} (${file})`);
    return readFileSync(file, "utf8");
}
/**
 * Compose an agent source: replace every include line with the fragment parts it names.
 * Includes only appear in the body, never in the frontmatter. `shared/` fragments may include
 * `lib/src` fragments; no other fragment nests.
 */
export function composeAgent(source, read = (name) => readFragment(name)) {
    const head = FRONTMATTER.exec(source)?.[0] ?? "";
    return expandRules(head) + composeBody(source.slice(head.length), read, true);
}
/** Replace a `# {{rules read-only-shell}}` frontmatter line with the shared shell permission entries. */
function expandRules(head) {
    return head
        .split("\n")
        .map((line) => {
        const match = RULES_LINE.exec(line.replace(/\r$/, ""));
        if (!match)
            return line;
        const indent = match[1];
        return READ_ONLY_SHELL_RULES.map((rule) => `${indent}- action: ${rule.action}\n${indent}  resource: ${JSON.stringify(rule.resource)}\n${indent}  effect: ${rule.effect}`).join("\n");
    })
        .join("\n");
}
function composeBody(body, read, allowShared) {
    const cache = new Map();
    const lines = body.split("\n").map((line) => {
        const include = INCLUDE.exec(line.replace(/\r$/, ""));
        if (!include) {
            if (line.includes("{{include"))
                throw new Error(`unreadable include line ${JSON.stringify(line)}`);
            return line;
        }
        const name = include[1];
        const shared = name.startsWith(SHARED_PREFIX);
        if (shared && !allowShared)
            throw new Error(`fragment ${name}: fragments do not nest`);
        let parts = cache.get(name);
        if (!parts) {
            parts = fragmentParts(name, read(name));
            cache.set(name, parts);
        }
        const wanted = include[2]?.trim().split(/\s+/).filter(Boolean) ?? [...parts.keys()];
        if (wanted.length === 0)
            throw new Error(`include ${name}: names no parts`);
        const text = wanted.map((id) => {
            const part = parts.get(id);
            if (part === undefined)
                throw new Error(`include ${name}: no part ${id}; it has ${[...parts.keys()].join(", ")}`);
            return part;
        });
        const joined = text.join("\n");
        if (shared)
            return composeBody(joined, read, false);
        if (joined.includes("{{include"))
            throw new Error(`fragment ${name}: fragments do not nest`);
        return joined;
    });
    return lines.join("\n");
}
/** The comment `scripts/build.ts` puts first in a composed agent's frontmatter. */
export function generatedComment(source) {
    return `# Generated by scripts/build.ts from ${source}. Do not edit.`;
}
/** Compose `source` and mark it generated: the comment becomes the first frontmatter line. */
export function composeAgentFile(source, sourceName, read) {
    const composed = composeAgent(source, read);
    if (!composed.startsWith("---\n"))
        throw new Error(`${sourceName}: no frontmatter`);
    return `---\n${generatedComment(sourceName)}\n${composed.slice(4)}`;
}
