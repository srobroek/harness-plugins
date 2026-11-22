import { describe, expect, test } from "bun:test";
import { parseVerdict, parseVerdictLine } from "./review-verdict.ts";
describe("parseVerdict", () => {
    test.each([
        ["VERDICT: APPROVE", "approve"],
        ["verdict: request-changes", "request-changes"],
        ["VERDICT: REQUEST_CHANGES", "request-changes"],
        ["Summary\n\nVERDICT:COMMENT", "comment"],
        ["VERDICT: APPROVE\nmore text\nVERDICT: REQUEST-CHANGES\ntrailing", "request-changes"],
        ["VERDICT: REQUEST-CHANGES\nlong findings follow\nmore findings", "request-changes"],
        ["VERDICT: APPROVED-ish", undefined],
        ["VERDICT: MAYBE", undefined],
        ["I would say VERDICT: APPROVE", undefined],
        ["", undefined],
        // Not a verdict: fenced, indented or quoted.
        ["```\nVERDICT: APPROVE\n```", undefined],
        ["~~~text\nVERDICT: APPROVE\n~~~", undefined],
        ["    VERDICT: APPROVE", undefined],
        ["\tVERDICT: APPROVE", undefined],
        ["> VERDICT: APPROVE", undefined],
        [">VERDICT: APPROVE", undefined],
        ["```\nunclosed fence\nVERDICT: APPROVE", undefined],
        // A real verdict is counted around them, and the last real one wins.
        ["VERDICT: COMMENT\n```\nVERDICT: APPROVE\n```", "comment"],
        ["VERDICT: REQUEST-CHANGES\n\n> VERDICT: APPROVE\n    VERDICT: APPROVE", "request-changes"],
        ["```\nVERDICT: APPROVE\n```\nVERDICT: APPROVE", "approve"],
        // Fence length and character: only a closing line of the same character, at least as long, bare.
        ["````\n```\nVERDICT: APPROVE\n```\n````", undefined],
        ["VERDICT: COMMENT\n````\n```\n````\nVERDICT: APPROVE", "approve"],
        ["VERDICT: COMMENT\n````\n```\nVERDICT: APPROVE\n````", "comment"],
        ["```\n~~~\nVERDICT: APPROVE\n~~~\n```", undefined],
        ["~~~\n```\nVERDICT: APPROVE\n```\n~~~\nVERDICT: REQUEST-CHANGES", "request-changes"],
        ["```\n``` not a close\nVERDICT: APPROVE\n```", undefined],
        ["~~~~\n~~~\nVERDICT: APPROVE\n~~~~\nVERDICT: COMMENT", "comment"],
        ["  VERDICT: APPROVE", "approve"],
    ])("%j -> %j", (text, expected) => {
        expect(parseVerdict(text)).toBe(expected);
    });
});
describe("parseVerdictLine", () => {
    test.each([
        ["VERDICT: APPROVE", { verdict: "approve", rest: "" }],
        ["VERDICT: APPROVE abc123", { verdict: "approve", rest: "abc123" }],
        ["VERDICT: REQUEST_CHANGES  abc123  ", { verdict: "request-changes", rest: "abc123" }],
        ["VERDICT: APPROVE aaa\nVERDICT: APPROVE bbb", { verdict: "approve", rest: "bbb" }],
        ["```\nVERDICT: APPROVE aaa\n```", undefined],
    ])("%j -> %j", (text, expected) => {
        expect(parseVerdictLine(text)).toEqual(expected);
    });
});
describe("parseVerdictLine strict", () => {
    test.each([
        ["VERDICT: APPROVE abc", true],
        ["notes\nVERDICT: APPROVE abc\n\n  \n", true],
        ["VERDICT: APPROVE abc\nbut wait", false],
        ["VERDICT: APPROVE abc\n```\ncode\n```", false],
        ["VERDICT: APPROVE abc\nVERDICT: REQUEST_CHANGES abc", true],
    ])("%j is a final verdict: %j", (text, expected) => {
        expect(parseVerdictLine(text, { strict: true }) !== undefined).toBe(expected);
    });
    test("the default mode keeps the last verdict line wherever it is", () => {
        expect(parseVerdictLine("VERDICT: APPROVE abc\nbut wait")).toEqual({ verdict: "approve", rest: "abc" });
    });
});
