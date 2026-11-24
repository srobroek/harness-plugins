/**
 * The shell permission rules of a reviewer that may also run the project's own tests.
 *
 * It is `READ_ONLY_SHELL_RULES` plus denies for the commands that install or change dependencies
 * and lockfiles. A test, lint or typecheck command (`pytest`, `uv run pytest`, `just check`,
 * `npm test`, `bun test`, `cargo test`, `go test`) matches the base `shell "*"` allow and none of
 * these denies, so it runs. The denies come last because OpenCode lets the last matching rule win.
 * The shared read-only list stays as it is for every other agent.
 *
 * Like the base list this is best-effort, not a sandbox: a wrapper, an interpreter or a script
 * that installs from inside a test run is out of its reach. The agent prompt carries the rest of the rule.
 *
 * Agent sources reference this list with a `# {{rules test-shell}}` comment line in the
 * frontmatter permissions; `composeAgent` expands it (see `fragments.ts`).
 */

import { READ_ONLY_SHELL_RULES, type ShellRule } from "./read-only-shell.ts"

const deny = (...resources: string[]): ShellRule[] => resources.map((resource) => ({ action: "shell", resource, effect: "deny" }))

export const TEST_SHELL_RULES: readonly ShellRule[] = [
  ...READ_ONLY_SHELL_RULES,
  // dependency installs and lockfile changes, per package manager
  ...deny(
    "npm install*", "npm i *", "npm i", "npm ci*", "npm add*", "npm update*", "npm uninstall*", "npm link*", "npm dedupe*", "npm audit fix*",
    "yarn install*", "yarn add*", "yarn remove*", "yarn up*", "yarn upgrade*",
    "pnpm install*", "pnpm i *", "pnpm i", "pnpm add*", "pnpm remove*", "pnpm update*", "pnpm up*",
    "bun install*", "bun i *", "bun i", "bun add*", "bun remove*", "bun update*", "bun link*",
    "pip install*", "pip uninstall*", "pip3 install*", "pip3 uninstall*", "python -m pip install*", "python -m pip uninstall*", "python3 -m pip install*", "python3 -m pip uninstall*",
    "uv add*", "uv remove*", "uv sync*", "uv lock*", "uv pip install*", "uv pip uninstall*", "uv pip sync*", "uv tool install*", "uv tool upgrade*",
    "poetry add*", "poetry install*", "poetry remove*", "poetry lock*", "poetry update*",
    "pipenv install*", "pipenv uninstall*", "pipenv lock*",
    "cargo add*", "cargo remove*", "cargo update*", "cargo install*", "cargo fetch*", "cargo generate-lockfile*",
    "go get*", "go install*", "go mod tidy*", "go mod download*", "go mod vendor*", "go work sync*",
    "bundle install*", "bundle add*", "bundle update*", "gem install*", "composer install*", "composer require*", "composer update*",
    "brew install*", "brew upgrade*", "apt install*", "apt-get install*", "dnf install*", "apk add*",
  ),
]
