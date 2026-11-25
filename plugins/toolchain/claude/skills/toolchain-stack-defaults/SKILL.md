---
name: toolchain-stack-defaults
description: Use when choosing or changing a project stack, package manager, or task runner, or when adding a dependency.
metadata:
  opencode/autoinvoke: false
---

# Toolchain Stack Defaults

Keep existing project choices unless the current task is explicitly about setup,
migration, or standardization.

Choose tools for a new project's constraints and conventions. Bun, npm, uv, pip, Poetry,
mise, language-specific version managers such as nvm or pyenv, just and make are options.
In an existing tree, retain its configured tools unless asked to change them.

Dependencies: add, remove, and upgrade them through the package manager's CLI
(`bun add`, `uv add`, `cargo add`, `go get`), not by hand-editing the
manifest's dependency tables.

Treat `just`, `mise`, and `moon` as independent setup choices:

- `just` for task aliases and repeatable local workflows.
- `mise` for language and tool version management.
- `moon` for task orchestration in larger monorepos.

Contracts: TypeSpec is the source of every serialized or published contract you own; see `toolchain-api` for emitters and exceptions.
Install the pinned tools through mise; the exact versions are in the `Contract tooling` table of `toolchain-api`, the one place they are written down.

Language plugins, when installed, add skills that run the project's own format,
lint, and test tools, and `lang-<language>-libraries` skills with the library
standards. Language design guidance lives in the `quality-code-design` skill.
