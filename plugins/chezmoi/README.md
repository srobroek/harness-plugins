# chezmoi

Refuses edits and shell writes to chezmoi-managed live files under `$HOME`, because
the next `chezmoi apply` overwrites them from source. The refusal names the source
path to edit instead (`chezmoi source-path <target>`).

Ported from the omp-plugins `chezmoi` plugin.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/chezmoi/opencode'
```

Claude Code install the skill from this repository's marketplace:

```sh
claude plugin install chezmoi@harness-plugins
```

Claude Code installs the skill without a write guard.

Pi loads `plugins/chezmoi/pi/extensions/chezmoi.js` as an extension. Foreground
children started by pi-subagents do not inherit parent extensions. Add the extension
to `subagents.defaultSubagentOnlyExtensions` in Pi settings:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/chezmoi.js"]
  }
}
```

For one agent, use `subagentOnlyExtensions` in its configuration. Set an absolute
path to the built extension.

## Guard

OpenCode's `tool.hook("execute.before")` and pi's `tool_call` handler block writes
to a managed target. They read write targets statically:

- `edit` and `write`: the named `path`.
- `patch` (OpenCode): each file header (`Add File`, `Update File`, `Delete File`,
  `Move to`).
- `shell` (OpenCode) and `bash` (pi): redirects (`>`, `>>`, `>|`), `tee`, and
  `cp`/`mv` destinations. The parser handles `-t DIR`, existing destination
  directories, `sed -i`/`gsed -i`, and `perl -i`.
- Wrapper prefixes: `sudo`, `doas`, `env`, `nice`, `timeout`, `stdbuf`, `command`,
  `exec`, `nohup`, `time`, and `VAR=value`.

Relative paths resolve against the call's working directory. A literal `cd DIR`
sets the working directory for following shell commands.

The guard checks paths under `$HOME` and resolves symlink aliases. It allows writes
inside the chezmoi source directory.

The guard reads `chezmoi managed --path-style=absolute` and caches the result for five
seconds. It reloads after a source-directory write or a shell command that runs
chezmoi. Seed-once `create_` targets remain writable. The guard blocks other managed
targets and names their source paths.

The guard ignores variable writes beyond `$HOME`, shell strings, scripts, and unlisted tools.

The plugin registers the `chezmoi-editor` skill from
`skills/chezmoi-editor/SKILL.md` unless a skill with that id already exists. The
skill links to `references/conventions.md` for source-file naming prefixes.
