import { describe, expect, test } from "bun:test"
import { parseAgentFile, permissionEffect } from "./agent-files.ts"
import { composeAgent } from "./fragments.ts"
import { READ_ONLY_SHELL_RULES } from "./read-only-shell.ts"
import { TEST_SHELL_RULES } from "./test-shell.ts"

const rules = [...TEST_SHELL_RULES]
const effect = (command: string) => permissionEffect(rules, "shell", command)
const readOnlyEffect = (command: string) => permissionEffect([...READ_ONLY_SHELL_RULES], "shell", command)

describe("test shell rules", () => {
  test.each([
    "pytest",
    "pytest -x tests/test_a.py",
    "uv run pytest",
    "just check",
    "npm test",
    "npm run lint",
    "bun test",
    "bun run typecheck",
    "cargo test",
    "go test ./...",
    "git diff HEAD",
    "rg foo",
  ])("allows %s", (command) => expect(effect(command)).toBe("allow"))

  test.each([
    "npm install",
    "npm install left-pad",
    "npm i left-pad",
    "npm ci",
    "yarn add x",
    "pnpm install",
    "bun install",
    "bun add x",
    "pip install x",
    "python -m pip install x",
    "uv add x",
    "uv sync",
    "uv lock",
    "uv pip install x",
    "poetry add x",
    "cargo add x",
    "cargo update",
    "cargo install x",
    "go get x",
    "go mod tidy",
    "bundle install",
  ])("denies the dependency change %s", (command) => expect(effect(command)).toBe("deny"))

  test.each(["git push origin main", "git commit -m x", "rm -rf x", "echo x > file", "bd close bd-1", "gh pr merge 7"])(
    "keeps the read-only denies: %s",
    (command) => expect(effect(command)).toBe("deny"),
  )

  test("the shared read-only list still allows installs, so only the test agents deny them", () => {
    expect(readOnlyEffect("npm install")).toBe("allow")
  })

  test("a frontmatter marker expands to the test rules, whatever follows it", () => {
    const source = '---\npermissions:\n  # {{rules test-shell}}\n  - action: edit\n    resource: "*"\n    effect: deny\n---\nBody\n'
    const file = parseAgentFile(composeAgent(source), "x")
    expect(file.permissions.filter((rule) => rule.action === "shell")).toEqual(rules)
    expect(permissionEffect(file.permissions, "edit")).toBe("deny")
  })
})
