---
name: project-secrets
description: "Use for secrets, credentials, API keys, fnox, 1Password, .env, vault or rotate: store, use, inspect and rotate project secrets."
---

# Project secrets

Use this skill when the project uses or chooses fnox for secret management. If the
project already uses another secret manager, follow that project's existing
workflow instead of introducing fnox or 1Password. The fnox guidance here (written
against 1.47) keeps references, not values, in committed `fnox.toml`; configured
providers supply values to commands through `fnox exec`. Do the smallest setup that
fits. The agent writes values it generates or a tool provides; it asks the user only
for values the user has (`references/store.md`).

## Never

- Put a value in the transcript. These commands print values, so never run them:
  - `fnox get`, `fnox export`, `fnox env`, `fnox list --values`
  - `op read`, `cat .env`, `echo $KEY`
- Run `op` directly, except the forms in
  `references/store.md` and an approved `op vault create`. The op-guard refuses the rest:
  - `--reveal`
  - `op item get`
  - `op read`
  - `op inject`
  - `op run`
  When using fnox, use `fnox exec` and `fnox provider discover` instead.
- Write a value literally in a command or a file. Never let it reach tool output.
- Commit any of these:
  - values and `.env`
  - `fnox.local.toml`
  - age identities and tokens
- Ask the user to paste a value into chat, or pass a value as an argument.

## Hosts

When the project uses fnox, configure its chosen host provider through the supported fnox configuration. Keep values out of this plugin; confirm provider availability with `fnox provider list` and `fnox config-files`.

## Fewer approvals

Each new 1Password session asks the user again. When the project uses a 1Password-backed
fnox provider, keep approvals to one per session:

1. Consume only with `fnox exec`, never `op` directly. Each direct `op` call opens a
   new session.
2. Run project commands from the project root.
   - Every call loads the same config files and shares one daemon cache entry.
   - A different directory, `-c` or profile is a separate entry and needs another approval.
3. Group commands that need the same secrets in one `fnox exec`.
4. Do not change fnox config files mid-session, because a change clears the cache.
5. If an approval fails or times out, stop and report the secret name. Never retry in a loop.

## Find your task

| Task | Read |
| --- | --- |
| Run a command with secrets | `references/use.md` |
| List the declared secrets, or diagnose a failure | `references/inspect.md` |
| Store or add a credential | `references/store.md` |
| Find an existing 1Password item | `references/store.md#find` |
| Choose where a secret lives, or configure a project, shared or per-project vault | `references/vaults.md` |
| Rotate, revoke or remove a secret | `references/rotate.md` |
| Environments, staging or production | `references/profiles.md` |
| Cache values for offline use | `references/fnox-config.md` |
| GitHub Actions | `references/ci-github.md` |
| Agent-side MCP | `references/mcp.md` |

Read the reference for your task only.
