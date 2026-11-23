---
name: toolchain-stack-defaults
description: Use when choosing or changing a project stack, package manager, or task runner, or when adding a dependency.
---
# Toolchain Stack Defaults

Keep existing project choices unless the current task is explicitly about setup, migration, or
standardization.

For new projects, prefer Bun over npm/yarn, uv over pip/Poetry, mise over nvm/pyenv, and just as a
task runner. Follow the language's own package and workspace tooling where it fits better.

Before adding a dependency, check the standard library and mature packages. Ask before adding a
dependency the request did not name. Language design guidance lives in the `quality-code-design`
skill.
