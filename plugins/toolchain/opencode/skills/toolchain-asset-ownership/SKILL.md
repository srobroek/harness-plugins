---
name: toolchain-asset-ownership
description: "Use when adding or changing agentic assets: where harness configuration, packages, skills and agents live and who owns them."
metadata:
  opencode/autoinvoke: false
---

# Agentic asset ownership

Keep these ownership boundaries when changing agentic assets; machine-specific guidance in `AGENTS.md` may add local paths:

- chezmoi owns machine-wide agent and harness configuration, global instructions, agents and skills. Use the `chezmoi-editor` skill, when installed, to edit source files rather than deployed files.
- The `srobroek/harness-plugins` repository owns installable harness packages (skills, agents, and plugin or extension code). Harness marketplaces are generated from the same plugin sources.
- A package change takes effect after the relevant harness rebuilds or updates it. A local checkout may need the repository's build command before installation.
- Use the selected harness's package list and reload/update command to inspect and load changed assets. Review project-local executable extensions and configuration before granting trust.

When an OpenCode plugin update fails with `ClientError ECONNRESET` or `Plugin is not configured`, read [references/pitfalls.md](references/pitfalls.md).
