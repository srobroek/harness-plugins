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

Contracts: TypeSpec is the source of every data or API contract that crosses a process,
language or repository boundary (`.proto` stays the source for protobuf and gRPC services).
Install the pinned tools through mise; `toolchain-api` has the routes, gates and dated versions.

| Job | Tool (checked 2026-11-25) |
| --- | --- |
| Author, format, compile | `@typespec/compiler` 1.18.0 (`tsp`) |
| OpenAPI 3.1 lint | Redocly CLI 2.83.0 |
| JSON Schema lint and meta-validation | Sourcemeta `jsonschema` 17.3.3 |
| Breaking changes | `oasdiff` v1.39.0 |
| Running-API tests | Schemathesis 4.34.2 |

Language plugins, when installed, add skills that run the project's own format,
lint, and test tools, and `lang-<language>-libraries` skills with the library
standards. Language design guidance lives in the `quality-code-design` skill.
