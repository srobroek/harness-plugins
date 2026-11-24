# secret-store

One tool, `safety_secret_store`, that stores a new secret without a shell. It ships for OpenCode and
pi. The [safety](https://github.com/srobroek/harness-plugins/tree/main/plugins/safety) plugin's
op-guard refuses every shell command that carries a secret value into `op item create|edit` or
`fnox set`, and its refusals point to this tool, so install the two together. The
[project-secrets](https://github.com/srobroek/harness-plugins/tree/main/plugins/project-secrets)
skill's `references/store.md` says when to use it.

The tool, its `safety_secret_store` and `safety_secret_command` permissions and their messages keep
the names they had in the safety plugin, so existing permission rules and steering still match.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/secret-store/opencode'
```

On pi, the plugin directory's `pi/` tree is a pi package, and `pi/extensions/secret-store.js` (built
from `pi-src/secret-store.ts`) registers the tool.

The tool supports two backends: a 1Password item that fnox references, and an fnox provider that
stores values. The 1Password target needs `op` on `PATH`, and both need `fnox`. A project on
another secret manager uses that manager's own workflow.

## The tool

`safety_secret_store({ name, target, generate | command, config?, description? })` stores a new secret
without a shell. The value stays out of:

- every command line and environment
- logs and error messages
- the tool result and the transcript

The inputs:

- `name` is the fnox secret name, `^[A-Z][A-Z0-9_]*$`.
- `generate: { charset, bytes | length }` draws from the CSPRNG. `ascii-printable` runs from `!` to
  `~`, with no space; the other charsets are `hex`, `base64url` and `alnum`. `bytes` asks for that much
  entropy, and `length` asks for that many characters. A request under 128 bits fails.
- `command: { argv, cwd? }` runs argv with no shell. Every run asks for the `safety_secret_command`
  permission and shows argv and cwd, never output. An `allow` rule becomes an `ask`, and a `deny`
  still refuses. The value is stdout with one trailing newline trimmed. More than 64 KiB stops the
  command. A non-zero exit fails with the exit code only. The tool discards stderr.
- `target: { kind: "1password", vault, item, field?, tags?, provider? }` pipes the item JSON on stdin
  to `op item create --vault=<vault> -`. The item is an API Credential with a concealed `credential`
  field. Next the tool runs `fnox set --provider=<p> -- NAME '<item>/<field>'`. The provider is the
  named one, or the only provider that the config file and the global config define as `1password`.
  When the provider is uncertain, the tool fails before it runs anything. When the provider's
  configured vault is not `vault`, or is uncertain, the reference is the full
  `op://<vault>/<item>/<field>`.
- `target: { kind: "fnox-store", provider }` pipes the value on stdin to `fnox set --provider=<p> -- NAME`.
  fnox reads a piped value when it gets no VALUE argument. The tool accepts only a provider whose type
  keeps a value it is given (age, keychain, the cloud secret managers and the others the safety
  op-guard counts as a value store). It refuses a value with whitespace at either end, since fnox
  trims it. This target replaces an existing value.
- `config` names the fnox config file, `fnox.toml` in the session directory by default. The file must
  exist. The tool resolves it with symlinks followed and passes the canonical path as
  `fnox --config=<path>`, so fnox loads only that file and the global config.

The config file pins where the value goes:

1. A file outside the session directory and its repository asks for the `external_directory`
   permission, the same way the host's file tools ask. A symlink inside the project that points
   outside counts as outside.
2. The tool reads the config file and the global config once and checks the provider against those
   bytes.
3. It asks for the `safety_secret_store` permission. The resource and the metadata name the secret,
   the target, the provider and the canonical config path.
4. It obtains the value. A command's process group is killed once the command exits.
5. It reads the config again with no cached data. When the digest of the files (paths, symlink
   targets, contents) differs, or the provider fails the check, the call stops and writes nothing.

A set `FNOX_CONFIG_DIR` or `FNOX_CONFIG`, or an `XDG_CONFIG_HOME` other than `~/.config`, stops the
call: fnox could then read a config the tool did not check. The result is
`{ name, reference, stored: true }` or `{ name, provider, stored: true }`, with no value or length.

A failure names the stage and the exit code, never child output. The tool retries nothing, so a
refused or timed-out 1Password approval stops the call. After the store, the tool zeroes its value
buffers. Copies inside the runtime's pipe buffers stay out of its reach.

## Asks

On OpenCode each step asks through `ctx.permission.assert`: `external_directory` for a config
outside the session, `safety_secret_store` for the store, and `safety_secret_command` for each
command run. A `permission.hook("evaluate")` hook turns an `allow` for `safety_secret_command` into an
`ask`, so every run asks. In a subagent session the safety plugin's `subagent-prompts` check denies
such an ask, or rejects it once raised when this plugin's hook runs after safety's.

On pi the same three steps open `ctx.ui.confirm`. A session without a dialog (print mode, JSON mode,
a child session without a UI) stops the call before anything is stored, as does a declined step.

## Limits

The tool checks the fnox config again after the value is obtained, but fnox reads the file itself.
It does not close one gap in the `command` source:

- What can happen: the command can start a detached process (for example with `setsid`) that leaves
  its process group. That process can change the fnox config after the recheck and before fnox reads
  it, so fnox can use another provider.
- Why it is accepted: the command prints the value, so it already has the value. The gap gives it
  nothing new. Only the `command` source has this gap, since `generate` runs no command.
- What to do: approve only commands you trust. When the secret does not come from a service, use
  `generate`.
