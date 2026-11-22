import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FORMULAS, installFormulas } from "./setup.ts";
// The speckit-setup skill tells Claude Code to copy `${CLAUDE_PLUGIN_ROOT}/formulas/` into `.beads/formulas/`.
// The Claude Code tree is installed on its own, so the formulas have to sit in it.
const CLAUDE_TREE = join(import.meta.dir, "..", "..", "claude");
let root = "";
beforeAll(() => {
    root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "speckit-claude-tree-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("the formulas install from an isolated copy of the Claude Code tree", () => {
    const installed = join(root, "installed");
    cpSync(CLAUDE_TREE, installed, { recursive: true, dereference: true });
    const repo = join(root, "repo");
    mkdirSync(repo);
    expect(installFormulas(repo, join(installed, "formulas"))).toEqual(FORMULAS.map((name) => `copied ${name}`));
    expect(readdirSync(join(repo, ".beads", "formulas")).sort()).toEqual(FORMULAS.map((name) => `${name}.formula.toml`).sort());
});
test("the Claude Code tree ships exactly the formulas setup installs", () => {
    expect(existsSync(join(CLAUDE_TREE, "formulas"))).toBe(true);
    expect(readdirSync(join(CLAUDE_TREE, "formulas")).sort()).toEqual(FORMULAS.map((name) => `${name}.formula.toml`).sort());
});
