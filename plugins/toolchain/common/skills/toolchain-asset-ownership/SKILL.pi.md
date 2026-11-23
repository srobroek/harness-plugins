---
name: toolchain-asset-ownership
description: "Use when adding or changing Pi configuration, packages, skills, prompt templates, agents, or MCP servers."
---
# Pi asset ownership

Keep these ownership boundaries when changing Pi assets. `AGENTS.md` may add machine-specific paths.

- chezmoi owns machine-wide Pi configuration under `~/.pi/agent/`: settings, MCP servers, the global `AGENTS.md`, extensions, skills, and prompt templates. Use `chezmoi-editor`, when installed, to edit their source rather than deployed files.
- The `srobroek/harness-plugins` repository owns installable Pi packages, skills, agents, prompt templates, and extension source.
- Pi loads installed package resources from the package manifest. A package change takes effect after `pi update --extensions`; for local development, install the local package or use its source directory.
- Project Pi configuration lives under `.pi/`: settings in `.pi/settings.json`, project MCP servers in `.pi/mcp.json`, skills in `.pi/skills/`, and prompt templates in `.pi/prompts/`. Project packages and resources load only after project trust is granted.
- Run `pi list` to inspect installed packages, `pi mcp list` to inspect configured MCP servers, and `/reload` to load changed resources in an active session.
