---
name: toolchain-asset-ownership
description: "Use when adding or changing OMP config, plugins, skills, agents, or tools."
---

Keep these ownership boundaries when changing agentic assets. `AGENTS.md` may add machine-
specific paths.

- chezmoi owns machine-wide OMP config under `~/.omp/agent/`: `config.yml`, global `AGENTS.md`,
  agents, and skills. Use `chezmoi-editor` when installed to edit its source.
- OMP's project-local skills install to `.agents/skills/<name>/` through the `agents` provider.
  `.omp/skills/` is not this install destination.
- Marketplace plugins install with `omp plugin install NAME@MARKETPLACE --scope project`. This
  creates or updates `.omp/plugins/installed_plugins.json`.
- `omp plugin install PACKAGE` installs an npm package for the user; `--scope` does not change
  that behavior.
- `new-project` owns OMP project tooling discovery and setup. After a skill change, use
  `/reload-plugins` or start a new session. A new extension, hook, or tool needs a restart.
