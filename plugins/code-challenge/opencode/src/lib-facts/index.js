import { execFile } from "node:child_process";
import { DiskCache, defaultCacheDir } from "./cache.ts";
import { collectPackage } from "./facts.ts";
import { Http } from "./http.ts";
import { nameProblem, versionProblem } from "./names.ts";
import { ECOSYSTEMS } from "./types.ts";
export { CACHE_TTL_MS, DiskCache, defaultCacheDir } from "./cache.ts";
export { ALLOWED_LICENCES, licenceBlocked } from "./licence.ts";
export const LIB_FACTS_TOOL = "challenge_lib_facts";
export const MAX_PACKAGES = 6;
export const LIB_FACTS_DESCRIPTION = "Registry, OSV and GitHub facts for 1-6 packages (npm, pypi, crates, go); facts only, no verdict.\n" +
    "Per package: latest version and date, releases in 12 and 24 months, licence, downloads, dependents, " +
    "GitHub activity, dependency counts, size, types, ESM/CJS, OSV advisories (always fresh), and the hard gates " +
    "unpatchedCve and licenceNotAllowed. A failed source is listed in `missing`; the call still succeeds. " +
    "Everything but OSV is cached for 7 days.";
export const LIB_FACTS_INPUT = {
    type: "object",
    properties: {
        ecosystem: { type: "string", enum: [...ECOSYSTEMS], description: "Package ecosystem" },
        packages: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PACKAGES,
            description: "Packages to look up; a version adds its OSV advisories",
            items: {
                type: "object",
                properties: { name: { type: "string" }, version: { type: "string" } },
                required: ["name"],
                additionalProperties: false,
            },
        },
    },
    required: ["ecosystem", "packages"],
    additionalProperties: false,
};
/** The validated request, or the reason it is invalid. */
export function readRequest(input) {
    const { ecosystem, packages } = (input ?? {});
    if (!ECOSYSTEMS.includes(ecosystem))
        return `ecosystem must be one of ${ECOSYSTEMS.join(", ")}`;
    if (!Array.isArray(packages) || packages.length < 1 || packages.length > MAX_PACKAGES)
        return `packages must hold 1 to ${MAX_PACKAGES} entries`;
    const parsed = [];
    for (const entry of packages) {
        const { name, version } = (entry ?? {});
        if (typeof name !== "string" || name.trim() === "")
            return "each package needs a non-empty name";
        const nameIssue = nameProblem(ecosystem, name.trim());
        if (nameIssue)
            return `${nameIssue}: ${JSON.stringify(name.slice(0, 80))}`;
        if (version === undefined) {
            parsed.push({ name: name.trim() });
            continue;
        }
        if (typeof version !== "string" || versionProblem(version.trim()))
            return `invalid version: ${JSON.stringify(String(version).slice(0, 80))}`;
        parsed.push({ name: name.trim(), version: version.trim() });
    }
    return { ecosystem: ecosystem, packages: parsed };
}
/** `gh auth token`, run by the tool so the value never reaches the transcript. `undefined` when gh is absent or signed out. */
export function ghToken() {
    return new Promise((resolve) => {
        execFile("gh", ["auth", "token"], { timeout: 5_000 }, (error, stdout) => {
            const token = error ? "" : stdout.trim();
            resolve(token === "" ? undefined : token);
        });
    });
}
export async function lookupLibFacts(ecosystem, packages, overrides = {}, signal) {
    const now = overrides.now ?? (() => new Date());
    const cache = new DiskCache(overrides.cacheDir ?? defaultCacheDir(), () => now().getTime());
    const http = new Http({
        fetch: overrides.fetch ?? fetch,
        cache,
        signal,
        timeoutMs: overrides.timeoutMs,
        maxBodyBytes: overrides.maxBodyBytes,
        concurrency: overrides.concurrency,
    });
    let token;
    const collector = { http, now, token: () => (token ??= (overrides.token ?? ghToken)()) };
    const results = await Promise.all(packages.map((p) => collectPackage(ecosystem, p, collector)));
    // A cancelled call is not a degraded one: stop rather than return facts built from aborted requests.
    signal?.throwIfAborted();
    return { ecosystem, fetchedAt: now().toISOString(), packages: results };
}
/** Register `challenge_lib_facts`. Dispose the returned registration with the plugin's other cleanups. */
export function registerLibFacts(ctx, overrides = {}) {
    return ctx.tool.transform((editor) => {
        editor.add({
            name: LIB_FACTS_TOOL,
            description: LIB_FACTS_DESCRIPTION,
            input: LIB_FACTS_INPUT,
            execute: async (input, context) => {
                const request = readRequest(input);
                if (typeof request === "string")
                    return { content: `${LIB_FACTS_TOOL}: ${request}`, metadata: { ok: false } };
                const facts = await lookupLibFacts(request.ecosystem, request.packages, overrides, context.signal);
                return { content: JSON.stringify(facts, null, 1), metadata: { ok: true, facts } };
            },
        });
    });
}
