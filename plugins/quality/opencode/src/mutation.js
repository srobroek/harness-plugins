import { capText, percent } from "./audit-util.ts";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function detectMutationFormat(data) {
    if (!isObj(data))
        return undefined;
    if (isObj(data.files) && "schemaVersion" in data)
        return "mutation-testing";
    if (Array.isArray(data.outcomes))
        return "cargo-mutants";
    if (Array.isArray(data.files) && "go_module" in data)
        return "gremlins";
    return undefined;
}
/** Keep the first mutant per key and number the rest, so reports with repeated spots still pair up. */
function add(into, mutant) {
    const base = `${mutant.file}|${mutant.mutator}|${mutant.location}|${mutant.replacement}`;
    let key = base;
    for (let n = 2; into.has(key); n++)
        key = `${base}#${n}`;
    into.set(key, { ...mutant, key });
}
const STRYKER = {
    Killed: "detected",
    Timeout: "detected",
    Survived: "survived",
    NoCoverage: "nocoverage",
};
const pos = (p) => (isObj(p) ? `${p.line}:${p.column}` : "?");
const span = (loc) => (isObj(loc) ? `${pos(loc.start)}-${pos(loc.end)}` : "?");
/** mutation-testing-report-schema (Stryker JS, Stryker.NET, Stryker4s and others). */
export function parseMutationTesting(data) {
    const mutants = new Map();
    for (const [name, entry] of Object.entries(isObj(data.files) ? data.files : {})) {
        if (!isObj(entry) || !Array.isArray(entry.mutants))
            continue;
        for (const m of entry.mutants) {
            if (!isObj(m))
                continue;
            const status = String(m.status ?? "");
            add(mutants, {
                file: name.replaceAll("\\", "/"),
                mutator: String(m.mutatorName ?? ""),
                location: span(m.location),
                replacement: typeof m.replacement === "string" ? m.replacement : "",
                status,
                class: STRYKER[status] ?? "ignored",
            });
        }
    }
    return { format: "mutation-testing", mutants };
}
const CARGO = { CaughtMutant: "detected", Timeout: "detected", MissedMutant: "survived" };
/** cargo-mutants `mutants.out/outcomes.json`; the baseline scenario is not a mutant. */
export function parseCargoMutants(data) {
    const mutants = new Map();
    for (const outcome of Array.isArray(data.outcomes) ? data.outcomes : []) {
        if (!isObj(outcome) || !isObj(outcome.scenario) || !isObj(outcome.scenario.Mutant))
            continue;
        const m = outcome.scenario.Mutant;
        const status = String(outcome.summary ?? "");
        add(mutants, {
            file: String(m.file ?? "").replaceAll("\\", "/"),
            mutator: String(m.genre ?? ""),
            location: span(m.span),
            replacement: String(m.replacement ?? ""),
            status,
            class: CARGO[status] ?? "ignored",
        });
    }
    return { format: "cargo-mutants", mutants };
}
const GREMLINS = {
    KILLED: "detected",
    "TIMED OUT": "detected",
    LIVED: "survived",
    "NOT COVERED": "nocoverage",
};
/** Gremlins `--output` JSON: per file, mutations with type, line and column (no replacement text). */
export function parseGremlins(data) {
    const mutants = new Map();
    for (const f of Array.isArray(data.files) ? data.files : []) {
        if (!isObj(f) || !Array.isArray(f.mutations))
            continue;
        for (const m of f.mutations) {
            if (!isObj(m))
                continue;
            const status = String(m.status ?? "");
            add(mutants, {
                file: String(f.file_name ?? "").replaceAll("\\", "/"),
                mutator: String(m.type ?? ""),
                location: `${m.line}:${m.column}`,
                replacement: "",
                status,
                class: GREMLINS[status] ?? "ignored",
            });
        }
    }
    return { format: "gremlins", mutants };
}
export function parseMutation(text, format) {
    const data = JSON.parse(text);
    const kind = format ?? detectMutationFormat(data);
    if (kind === undefined || !isObj(data))
        throw new Error("cannot detect the mutation format; pass format: mutation-testing, cargo-mutants or gremlins");
    if (kind === "mutation-testing")
        return parseMutationTesting(data);
    if (kind === "cargo-mutants")
        return parseCargoMutants(data);
    return parseGremlins(data);
}
export function scoreOf(report) {
    const s = { detected: 0, survived: 0, nocoverage: 0, ignored: 0, score: 0 };
    for (const m of report.mutants.values())
        s[m.class]++;
    s.score = percent(s.detected, s.detected + s.survived + s.nocoverage);
    return s;
}
const ref = (m, other) => ({
    key: m.key,
    file: m.file,
    mutator: m.mutator,
    location: m.location,
    replacement: m.replacement,
    was: m.status,
    now: other?.status ?? "absent",
});
const undetected = (c) => c === "survived" || c === "nocoverage";
/** Pair mutants by file, mutator, location and replacement; the lost-protection list is the key result. */
export function compareMutation(baseline, candidate) {
    const lostProtection = [];
    const newlyKilled = [];
    const onlyInBaseline = [];
    const onlyInCandidate = [];
    for (const [key, base] of baseline.mutants) {
        const cand = candidate.mutants.get(key);
        if (cand === undefined)
            onlyInBaseline.push(ref(base));
        else if (base.class === "detected" && undetected(cand.class))
            lostProtection.push(ref(base, cand));
        else if (undetected(base.class) && cand.class === "detected")
            newlyKilled.push({ ...ref(base, cand) });
    }
    for (const [key, cand] of candidate.mutants)
        if (!baseline.mutants.has(key))
            onlyInCandidate.push(ref(cand));
    return {
        kind: "mutation",
        baselineFormat: baseline.format,
        candidateFormat: candidate.format,
        baseline: scoreOf(baseline),
        candidate: scoreOf(candidate),
        lostProtection,
        newlyKilled,
        onlyInBaseline,
        onlyInCandidate,
    };
}
const describe = (r) => `${r.file}:${r.location.split("-")[0]} ${r.mutator}${r.replacement ? ` -> ${r.replacement.replace(/\s+/g, " ").slice(0, 40)}` : ""}`;
function section(title, refs, limit, show) {
    if (refs.length === 0)
        return [];
    const out = [`${title} (${refs.length}):`, ...refs.slice(0, limit).map((r) => `  ${show(r)}`)];
    if (refs.length > limit)
        out.push(`  ... +${refs.length - limit} more`);
    return out;
}
const fmtScore = (s) => `${s.score}% (${s.detected} detected, ${s.survived} survived, ${s.nocoverage} no coverage, ${s.ignored} ignored)`;
export function formatMutation(c) {
    const lines = [`mutation score: ${fmtScore(c.baseline)} -> ${fmtScore(c.candidate)}`];
    lines.push(...section("LOST PROTECTION (detected in baseline, survived or uncovered in candidate)", c.lostProtection, 25, (r) => `${describe(r)}  [${r.was} -> ${r.now}]`));
    if (c.lostProtection.length === 0)
        lines.push("lost protection: none");
    lines.push(...section("newly killed", c.newlyKilled, 8, describe), ...section("only in baseline (candidate has no such mutant)", c.onlyInBaseline, 8, (r) => `${describe(r)}  [${r.was}]`), ...section("only in candidate", c.onlyInCandidate, 8, (r) => `${describe(r)}  [${r.was}]`));
    return capText(lines);
}
