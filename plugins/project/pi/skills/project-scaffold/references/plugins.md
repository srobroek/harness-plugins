# Choosing Pi packages

Choose packages by project need; do not re-add what is already configured globally.

## 1. Inspect installed packages

Run `pi list` to see configured Pi packages. Pi loads project packages from `.pi/settings.json` after project trust is granted; user-level packages are configured in the agent directory's `settings.json`.

## 2. Find suitable packages

Use `find_tools_scan` with capability terms (for example `rust lint` or `issue tracking`) and `sources: ["local", "catalog"]` when available. `local` covers installed tools, and `catalog` is this repository's plugin marketplace. The repository's plugin manifests and README cover plugins that are not listed in the marketplace.

The project-scoped shortlist in `references/plugins.md` identifies signals for adding individual plugins. Ask before adding a package that is not clearly needed. A package may provide extensions, skills, prompt templates, or MCP configuration; inspect its `pi` manifest and exact resources before installation.

## 3. Install a package for the project

Review the package source, then use Pi's project-scoped installer:

```sh
pi install --local npm:@srobroek/<name>
```

For a git source, use `pi install --local git:github.com/srobroek/harness-plugins#main` when that repository layout can be selected as a package; otherwise use the plugin's published npm package. Confirm with `pi list` and inspect `.pi/settings.json`. Pi loads project resources only after trust is granted.

Package updates run with `pi update --extensions`. Use `--local` when operating on project package configuration. Project trust and package code execution remain the user's decision.
