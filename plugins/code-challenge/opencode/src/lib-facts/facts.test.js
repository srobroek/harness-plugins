import { describe, expect, test } from "bun:test";
import { deprecation } from "./facts.ts";
describe("deprecation", () => {
    test.each([
        [[], null],
        [[null, undefined, null], null],
        [[false], false],
        [[null, false, undefined], false],
        [[true], true],
        [[false, true, false], true],
        [[null, true], true],
    ])("%j -> %p", (answers, expected) => {
        expect(deprecation(answers)).toBe(expected);
    });
});
