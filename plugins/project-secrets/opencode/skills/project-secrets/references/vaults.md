# Where a secret lives
Source: https://fnox.jdx.dev/guide/config-files, /providers/1password.

| Situation | Where it lives |
| --- | --- |
| Machine-wide value already configured by the user | Nothing in the project |
| One user, one machine, one project | A private vault, item `<project> <purpose>`, tag `project/<project>` |
| CI or collaborators need a shared credential | A user-configured shared vault and provider |
| A project has its own service account or distinct access | A user-configured project vault and provider |
| Local-only generated value | OS keychain (`references/store.md`) |

A machine-wide key is not a project secret. It belongs in the user's managed global
configuration. Ask which provider and vault the user has configured; do not invent names.

## When a vault is worth it

Access differs when users or services need different permissions. Confirm whether the service account can access the selected vaults before placing CI secrets there.

So CI needs its secrets in a vault accessible to the project's service account. For a solo project, one private vault may be enough. When access differs, use separate user-configured vaults.

## Create a project vault

1. Ask the user; never create a vault unasked.
2. After approval, create a vault using the configured provider's documented process.
3. Declare the provider and vault in the project `fnox.toml` using names supplied by the user:

```toml
[providers.project]
type = "1password"
vault = "<user-configured-vault>"
```

4. The user creates any service account in their secret manager and confirms which vaults it can access.

## Provider names

The user's global configuration owns machine-wide provider settings. Project providers must use names that do not replace a global entry. Ask which provider names the user configured; do not hard-code host mappings or external service names.

Top-level `env` and `if_missing` take the closest file's value, so set them on each secret.
