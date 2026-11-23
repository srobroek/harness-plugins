# repomix

Packs a local directory, or a remote repository at a ref, into one file with
[repomix](https://github.com/yamadashy/repomix), for questions that need many files at
once: an external repo's layout and APIs, a whole module for review, a diff between two
versions, or a doc set. The pack goes to a file and only its path and metrics come back,
so it never lands in the context.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/repomix/opencode'
```

Install repomix globally (`mise use -g npm:repomix@1.19.0` or `npm i -g repomix`). Without
it on PATH, the tool runs `npx --yes repomix@1.19.0`, because npx downloads code. Your
permission rules decide whether that runs; set `confirmPack` (below) to prompt first.

## Tool

`repomix_pack` takes `directory` (default: the session directory) or `remote`
(`owner/repo` or an https URL) with an optional `ref`, plus `include` and `ignore` globs,
`compress`, `style` (`xml`, `markdown` or `plain`), `lineNumbers` and `timeoutSeconds`
(default 300). It writes `repomix-<target>-<id>.<ext>` to `$TMPDIR/opencode/repomix/` and
returns the path, the file, token and character totals, the ten largest files, and the
files the secret scan left out. Packs older than a day are removed on the next run.

Every run:

- passes `--config` an empty JSON file, so neither the target's `repomix.config.*` (a JS
  or TS config is code) nor your global repomix config is loaded. A target's
  `.repomixignore` and `.gitignore` still apply.
- runs in an empty directory under the temp dir.
- never passes `--no-security-check` or `--remote-trust-config`.
- passes `--no-file-summary` and `--no-git-sort-by-changes`, so two packs of one repo at
  different refs diff cleanly.

The tool asks permission as `repomix_pack`, with the absolute directory or `remote@ref` as
the resource. Your permission rules decide: an allowed call runs without a prompt, and a deny
or ask rule always wins. To prompt when a pack would run through npx, even if a rule allows
it, set the plugin option `confirmPack` to `true` (default `false`):

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/harness-plugins::path:plugins/repomix/opencode",
    "options": { "confirmPack": true }
  }]
}
```

The `researcher` agent (agent-researcher, and delivery's fallback copy) and build's
`external-repo-worker` allow `repomix_pack`. Other agents keep your default for it, which
is a prompt unless you configure otherwise. The shipped allowlist agents deny it.

## Skill

`repomix` lists when packing beats grep and read, the recipes for each case, how to read
a pack in slices, and when `compress` loses information. It also carries a CLI recipe,
so it is exported to Claude Code.

The npm package exposes `repomix_pack` as a Pi tool. It confirms before packing; the pack is written under a temp directory, and only the path and metrics are returned.

## Optional: the repomix MCP server

The plugin does not configure the repomix MCP server. In Pi's `.pi/mcp.json` or the user MCP configuration, `repomix --mcp` exposes its tools. `--sandbox` confines file access to the working directory but disables remote packing.
