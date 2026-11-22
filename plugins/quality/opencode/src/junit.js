import { XMLParser, XMLValidator } from "fast-xml-parser";
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name === "testcase",
});
const isNode = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function count(value) {
    return Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
}
function caseStatus(node) {
    if ("failure" in node || "rerunFailure" in node)
        return "failed";
    if ("error" in node || "rerunError" in node)
        return "error";
    if ("skipped" in node)
        return "skipped";
    return "passed";
}
const TIMEOUT = /time(?:d)?[\s-]?out/i;
const FAILURE_KEYS = ["failure", "error", "rerunFailure", "rerunError"];
/** Only this many characters of each failure body are read; the message and type are read whole. */
const BODY_LIMIT = 2000;
const str = (value) => (typeof value === "string" ? value : "");
/** Text of an element: a plain string, or the `#text` of one that has attributes. */
function elementText(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return value.map(elementText).join("\n");
    return isNode(value) ? str(value["#text"]) : "";
}
/**
 * Heuristic: a failure is a timeout when the message or type of any one failure element, or the
 * start of its body, matches "timeout", "timed out" or "time-out" (case-insensitive). Each element
 * is read on its own, so a long body cannot hide the metadata of a later `rerunFailure`.
 * Everything else is `other`.
 */
export function classifyFailure(node) {
    for (const key of FAILURE_KEYS) {
        const value = node[key];
        for (const item of Array.isArray(value) ? value : [value]) {
            const fields = isNode(item)
                ? [str(item["@_message"]), str(item["@_type"]), str(item["#text"]).slice(0, BODY_LIMIT)]
                : [str(item).slice(0, BODY_LIMIT)];
            if (fields.some((field) => TIMEOUT.test(field)))
                return "timeout";
        }
    }
    return "other";
}
/** Non-empty lines of the `system-err` element(s) under `value`. */
function stderrLines(value) {
    return elementText(value)
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "").length;
}
/** Stderr lines of every `system-err` under `node`, at any depth, each counted once. */
function nestedStderrLines(node) {
    if (Array.isArray(node))
        return node.reduce((sum, item) => sum + nestedStderrLines(item), 0);
    if (!isNode(node))
        return 0;
    let lines = 0;
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("@_"))
            continue;
        lines += key === "system-err" ? stderrLines(value) : nestedStderrLines(value);
    }
    return lines;
}
function collect(node, out) {
    if (Array.isArray(node)) {
        for (const item of node)
            collect(item, out);
        return;
    }
    if (!isNode(node))
        return;
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("@_"))
            continue;
        if (key === "system-err") {
            out.stderrLines += stderrLines(value);
            continue;
        }
        if (key !== "testcase") {
            collect(value, out);
            continue;
        }
        for (const raw of value) {
            const tc = isNode(raw) ? raw : {};
            const name = String(tc["@_name"] ?? "");
            const classname = String(tc["@_classname"] ?? "");
            const file = tc["@_file"] === undefined ? "" : String(tc["@_file"]);
            const label = [classname, name].filter(Boolean).join(" :: ");
            const time = Number.parseFloat(String(tc["@_time"] ?? "0"));
            const status = caseStatus(tc);
            out.stderrLines += nestedStderrLines(tc);
            out.cases.push({
                id: file ? `${file} :: ${label}` : label,
                status,
                time: Number.isFinite(time) ? time : 0,
                retries: count(tc.flakyFailure) + count(tc.flakyError),
                ...(status === "failed" || status === "error" ? { failureKind: classifyFailure(tc) } : {}),
            });
        }
    }
}
/**
 * Test cases of a JUnit XML report, in document order. Handles the nesting the supported writers
 * produce: pytest `--junitxml`, Vitest, `bun test --reporter=junit` (nested suites), gotestsum
 * `--junitfile` and cargo-nextest. Throws on input that is not XML with a `testsuite(s)` root.
 */
export function parseJunit(xml) {
    return parseJunitReport(xml).cases;
}
/** Like `parseJunit`, and also counts the stderr lines the report carries. */
export function parseJunitReport(xml) {
    const valid = XMLValidator.validate(xml);
    if (valid !== true)
        throw new Error(`invalid XML: ${valid.err.msg} (line ${valid.err.line})`);
    const doc = parser.parse(xml);
    if (!("testsuites" in doc) && !("testsuite" in doc))
        throw new Error("not a JUnit report: no testsuite element");
    const out = { cases: [], stderrLines: 0 };
    collect(doc, out);
    return out;
}
