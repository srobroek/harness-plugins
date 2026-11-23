---
name: toolchain-asset-ownership
description: "Use when adding or changing OMP configuration, plugins, skills, agents, or tools."
---
# Agentic asset ownership

Keep these ownership boundaries when changing agentic assets. `AGENTS.md` may add machine-
specific paths.

- chezmoi owns machine-wide configuration under the user agent directory. Use `chezmoi-editor`
  when installed to edit its source.
- Project-local skills install to `.agents/skills/<name>/` through the `agents` provider. The
  OMP directory is not this install destination.
- Use `new-project` for project tooling discovery and setup. It distinguishes project-local skills
  from marketplace extensions and npm packages.
- After a skill change, use `/reload-plugins` or start a new session. A new extension, hook, or
  tool needs a restart.
