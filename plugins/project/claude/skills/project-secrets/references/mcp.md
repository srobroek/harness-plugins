# fnox MCP server (optional)

Source: https://fnox.jdx.dev/guide/mcp. `fnox mcp` serves secrets to an agent over stdio.
Default for projects: do not enable it; `fnox exec` from the shell tool is enough. If the user asks, enable it, for example to let the agent request a missing secret.

Redaction and allowlists are not isolation: the agent chooses the command, and a command
can encode or send a value. Never enable `get_secret`, which returns raw values.

```toml
# fnox.toml
[mcp]
tools = ["exec", "request_secret"]     # the default is ["get_secret", "exec"]: set it explicitly
secrets = ["STRIPE_KEY", "SENTRY_TOKEN"]   # allowlist; default is every secret in the profile
```

- `exec` runs a command with the allowed secrets and returns output with values replaced
  by `[REDACTED]` (literal matches only; base64 slips through).
- `request_secret` asks the agent's client for a one-time local page. The user types the
  value there, and the model does not see it. It needs MCP URL-mode elicitation.
  Without it, fnox tells the agent to run `fnox set NAME`. The agent pipes in its own
  values. The user types user-only values.
- fnox refuses plaintext storage. The secret's provider (or `default_provider`) must be one of:
  - an encrypting provider (age)
  - a local store (`keychain`)
  - a remote store (1Password)

  Prefer keychain or age, since `fnox set` cannot write to 1Password.
- Whatever `[mcp]` says, the agent can read machine keys loaded by the user's shells at start.
  Keep project secrets `env = "exec"`.

Start the OMP client from the project directory so fnox finds `fnox.toml`. Sign in to providers
first, because the server never prompts. Use `fnox -P staging mcp` to serve a profile. Follow
`new-project` for the OMP-specific `.omp/mcp.json` configuration format. Add an MCP server only
when the user asks.
