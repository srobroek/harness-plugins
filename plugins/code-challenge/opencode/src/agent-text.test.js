import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The scout in dogfood round 2 was handed reference paths and read none of them, so the contract is pinned in
// the texts a model reads. Each check names an obligation, not a wording, and each has a negative case: the
// shipped text with that one obligation removed must fail, which shows the check bites.
const common = join(import.meta.dir, "..", "..", "common");
const text = (...parts) => readFileSync(join(common, ...parts), "utf8");
/** The text from the first match of `start` up to the next match of `end` after it (or the end of the source). */
function section(source, start, end) {
    const from = source.search(start);
    if (from < 0)
        return "";
    const to = source.slice(from + 1).search(end);
    return to < 0 ? source.slice(from) : source.slice(from, from + 1 + to);
}
/** `source` with `find` replaced; fails loudly when `find` is absent, so a rewording cannot turn a negative case into a no-op. */
function without(source, find, replacement = "") {
    expect(source).toMatch(find);
    return source.replace(find, replacement);
}
/** Obligations missing from a code-challenger prompt; empty when it keeps all of them. */
function agentProblems(agent) {
    const problems = [];
    const protocol = section(agent, /^## Protocol/m, /^## Rules/m);
    const output = section(agent, /^## Output/m, /^$(?![\s\S])/);
    const reads = protocol.search(/lens reference/i);
    const target = protocol.search(/\bRead the target\b/i);
    const firstStep = protocol.slice(0, target < 0 ? undefined : target);
    if (!/\b(every|each|all)\b[\s\S]{0,60}lens reference/i.test(firstStep))
        problems.push("every lens reference in the Brief");
    if (!/evidence\.md/.test(firstStep))
        problems.push("evidence.md");
    if (reads < 0 || target < 0 || reads > target || !/\bbefore\b[\s\S]{0,40}\banaly/i.test(firstStep))
        problems.push("read before analysis");
    if (!output.includes("References read:"))
        problems.push("References read: line");
    if (!/References read:[^\n]*\babsolute\b/i.test(output))
        problems.push("absolute paths on the line");
    return problems;
}
/** Obligations missing from the skill's CHALLENGE step. */
function skillProblems(skill) {
    const problems = [];
    const step = section(skill, /^3\. CHALLENGE/m, /^4\. /m);
    const reject = step.search(/\breject/i);
    if (reject < 0 || !step.slice(reject).includes("References read:"))
        problems.push("reject a reply without the line");
    if (!/fewer references|fewer than/i.test(step))
        problems.push("reject a reply with fewer references");
    const reask = step.search(/(re-ask|ask again)[^.]*\bonce\b/i);
    if (reask < 0 || /twice|\bthree\b|repeatedly/i.test(step))
        problems.push("re-ask exactly once");
    const gap = step.slice(Math.max(reask, 0)).search(/\bgap\b/i);
    if (reask < 0 || gap < 0)
        problems.push("record a gap after the second short reply");
    return problems;
}
/** Obligations missing from the analyse-lens step of mol-challenge-lens. */
function formulaProblems(toml) {
    const data = Bun.TOML.parse(toml);
    const description = data.steps?.find((step) => step.id === "analyse-lens")?.description ?? "";
    const problems = [];
    if (!description.includes("References read:"))
        problems.push("References read: line");
    if (!/\babsolute\b/i.test(description))
        problems.push("absolute paths");
    return problems;
}
const agent = text("agents", "code-challenger.md");
const skill = text("skills", "code-challenge", "SKILL.md");
const formula = text("formulas", "mol-challenge-lens.formula.toml");
describe("code-challenger prompt", () => {
    test("keeps every obligation", () => expect(agentProblems(agent)).toEqual([]));
    test.each([
        ["reading every lens reference", (s) => without(s, /read every lens reference named in the Brief/, "read the lens reference of the Brief"), "every lens reference in the Brief"],
        ["reading evidence.md first", (s) => without(s, /evidence\.md/g, "it"), "evidence.md"],
        ["reading before analysis", (s) => without(s, /BEFORE you analyse anything/), "read before analysis"],
        ["the References read: line", (s) => without(s, /`References read:`/g, "a list"), "References read: line"],
        ["absolute paths on the line", (s) => without(s, /lists the absolute paths/, "lists the paths"), "absolute paths on the line"],
    ])("without %s it fails", (_name, mutate, problem) => {
        expect(agentProblems(mutate(agent))).toContain(problem);
    });
});
describe("the skill's CHALLENGE step", () => {
    test("keeps every obligation", () => expect(skillProblems(skill)).toEqual([]));
    test.each([
        ["rejecting a reply without the line", (s) => without(s, /Reject a scout reply that lacks the line `References read:` or /, "Accept a scout reply that "), "reject a reply without the line"],
        ["rejecting fewer references", (s) => without(s, /fewer references than the brief named/, "an odd number"), "reject a reply with fewer references"],
        ["re-asking once", (s) => without(s, /re-ask once/, "keep re-asking"), "re-ask exactly once"],
        ["re-asking more than once", (s) => without(s, /re-ask once/, "re-ask once, then twice more"), "re-ask exactly once"],
        ["recording a gap", (s) => without(s, /record a gap/, "carry on"), "record a gap after the second short reply"],
    ])("without %s it fails", (_name, mutate, problem) => {
        expect(skillProblems(mutate(skill))).toContain(problem);
    });
});
describe("mol-challenge-lens analyse-lens step", () => {
    test("keeps every obligation", () => expect(formulaProblems(formula)).toEqual([]));
    test.each([
        ["the line", (s) => without(s, /`References read:`/, "a list"), "References read: line"],
        ["absolute paths", (s) => without(s, /the absolute paths/, "the paths"), "absolute paths"],
    ])("without %s it fails", (_name, mutate, problem) => {
        expect(formulaProblems(mutate(formula))).toContain(problem);
    });
    test("the line only counts inside the analyse-lens step", () => {
        const elsewhere = without(formula, /End the reply with a `References read:` line listing the absolute paths you read first\. /).replace("[[steps]]\nid = \"record-findings\"", "# `References read:` absolute\n[[steps]]\nid = \"record-findings\"");
        expect(formulaProblems(elsewhere)).toEqual(["References read: line", "absolute paths"]);
    });
});
