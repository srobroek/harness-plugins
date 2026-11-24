# project-secrets

Per-project secrets with [fnox](https://fnox.jdx.dev/) and its configured providers, 1Password among
them, as one skill. A project on another secret manager follows that manager's own workflow.

| Skill | When |
| --- | --- |
| `project-secrets` | Secrets, API keys, `.env`, fnox, 1Password, CI secrets or AWS credentials for a project |

The skill gives guidance and the questions to ask the user. It covers:

- a committed `fnox.toml` of references, never values, when the project uses fnox
- where secrets live according to the project's configured provider and access policy
- the gitignored `fnox.local.toml` sync cache
- running commands through `fnox exec` and mise tasks
- the rules that keep values out of the transcript

It assumes the host's global fnox config (for example `op` and `age` providers and shared
machine keys) and does not declare it again. Commands were checked against fnox 1.47.

Each task has its own reference in `references/`:

| Reference | Task |
| --- | --- |
| `use.md` | Run a command with secrets |
| `inspect.md` | List the declared secrets, or diagnose a failure |
| `store.md` | Store a credential, or find an existing 1Password item |
| `vaults.md` | Choose a vault, or set up a shared or per-project one |
| `rotate.md` | Rotate, revoke or remove a secret |
| `profiles.md` | Environments, staging or production |
| `fnox-config.md` | The config file, and caching values for offline use |
| `ci-github.md` | GitHub Actions: a service account or `fnox push` |
| `mcp.md` | `fnox mcp` for agents, off by default |

`store.md` writes a value the agent generates, or one a command prints, through the
`safety_secret_store` tool of the
[secret-store](https://github.com/srobroek/harness-plugins/tree/main/plugins/secret-store) plugin,
which supports 1Password items and fnox value stores. Without that plugin it gives shell steps
instead. The [safety](https://github.com/srobroek/harness-plugins/tree/main/plugins/safety)
plugin's op-guard refuses those steps, so install secret-store next to safety.

The [project](https://github.com/srobroek/harness-plugins/tree/main/plugins/project) plugin's
`project-scaffold` skill loads this skill for its secrets step.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/project-secrets/opencode'
```

Claude Code installs the same skill from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install project-secrets@harness-plugins
```

A skill you already have with the same name wins over the plugin's copy.

## Works with

This package works with these pi packages. Install them next to it.

| Package | Required | For | Install |
| --- | --- | --- | --- |
| `@srobroek/pi-secret-store` | no | the safety_secret_store tool that references/store.md uses to write a value without a shell | `pi install npm:@srobroek/pi-secret-store` |
