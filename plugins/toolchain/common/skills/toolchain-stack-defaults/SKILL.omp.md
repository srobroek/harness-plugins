---
name: toolchain-stack-defaults
description: Use when choosing or changing a project stack, package manager, or task runner, or when adding a dependency.
---
# Toolchain Stack Defaults

Keep existing project choices unless the current task is explicitly about setup, migration, or
standardization.

For new projects, prefer Bun over npm/yarn, uv over pip/Poetry, mise over nvm/pyenv, and just as a
task runner. Follow the language's own package and workspace tooling where it fits better.

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

Before adding a dependency, check the standard library and mature packages. Ask before adding a
dependency the request did not name. Language design guidance lives in the `quality-code-design`
skill.
