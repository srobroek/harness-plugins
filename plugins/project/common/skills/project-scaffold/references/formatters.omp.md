---
name: formatters
---
# Formatter config

Choose a formatter based on the language tools and configure it explicitly in the language's
native config. Follow the language's quality skill for formatter and gate. Keep a formatting
check in `just check`; do not configure automatic edit-time formatting.

## Python: Ruff

Put the config in `pyproject.toml`. In `ruff.toml` (only when there is no `pyproject.toml`),
drop the `tool.ruff` prefix: settings sit at the root and tables are `[format]` and `[lint]`.

```toml
[tool.ruff]
line-length = 100          # measure from existing code
target-version = "py312"   # match requires-python

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
docstring-code-format = true

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP", "B", "SIM", "TC", "ANN", "RUF", "PERF", "C4", "PT", "S"]
ignore = ["E501"]          # ruff format owns line length

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101", "ANN"]
```

- Greenfield: use Ruff's default line length (88) unless the user picks another.
- Existing code: measure rather than imposing 88. Run `ruff format --diff --line-length <n> .`
  at a few widths and pick the smallest diff, or read the longest common line length. Copy the
  quote style the code already uses.
- `lint.select` lists the rules the project enforces; for existing code, start with CI.
- `ignore = ["E501"]`: `ruff format` sets line length. E501 only flags lines the formatter cannot split (long strings, comments, URLs), and pi-lens reports each one as a blocker.

## JavaScript and TypeScript: Biome or oxfmt

Pick one formatter per file type. Never configure two formatters for the same files: the check
and agent must not disagree.

- Biome is one default option for lint and format, including JSON, CSS and GraphQL. Check the
  existing project first; otherwise ask whether to choose Biome or oxfmt, and add Biome only if
  selected.

  ```json
  {
    "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
    "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
    "formatter": { "enabled": true, "indentStyle": "space", "lineWidth": 100 },
    "linter": { "enabled": true, "rules": { "recommended": true } },
    "javascript": { "formatter": { "quoteStyle": "double" } }
  }
  ```

  Use the local `$schema` path so it follows the installed Biome; do not pin a versioned URL.
- oxfmt: choose it with Oxlint or for Prettier-compatible output without Prettier. Add `oxfmt`
  as a dev dependency and commit `.oxfmtrc.json` (`oxfmt --init` writes one):

  ```json
  {
    "$schema": "./node_modules/oxfmt/configuration_schema.json",
    "printWidth": 100,
    "singleQuote": false
  }
  ```

  If Biome stays for linting, set `"formatter": { "enabled": false }` in `biome.json` to avoid
  double-formatting JS/TS.
- Prettier stays off by default. If used, add it and make the gate run `prettier --check`;
  disable other formatters for the same files.

## Existing code

Commit the config with a one-time format pass (`just fmt`) in its own commit. List that commit in
`.git-blame-ignore-revs` so `git blame` skips it.
