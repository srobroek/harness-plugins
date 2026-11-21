---
name: chezmoi-editor
description: Edits chezmoi-managed dotfiles at their source; use when changing dotfiles, templates, or global agent and tool config.
---

# Chezmoi Editor

Use this skill when a task changes files managed by chezmoi. Resolve the managed
source first; do not edit the rendered live target as the durable fix.

In OpenCode, the chezmoi plugin refuses `edit`, `write` and `patch` calls that
target a managed file, and common literal shell writes (`>`/`>>` redirects, `tee`,
`cp`/`mv`, `sed -i`, `perl -i`). The refusal names the source path to edit. It reads
literal words only: writes through `sh -c`, the shell eval builtin, scripts, variables other than
`$HOME`, or other tools pass unchecked, so resolve the source yourself.

## Workflow

1. Determine whether the target is managed:
   - `chezmoi managed`
   - `chezmoi source-path <target>` when a specific target is known
   - existing symlink/source layout when chezmoi cannot resolve it directly
2. Edit the source under the chezmoi source tree, not `$HOME` runtime output.
3. Use native chezmoi names for dotfiles, executables, private files, readonly
   files, symlinks, scripts, and templates.
4. Never write a credential in plaintext. Read it at apply time with
   `{{ onepasswordRead "op://<vault>/<item>/<field>" }}` in a `.tmpl` file, or
   store the file with `chezmoi add --encrypt <target>`. `private_` only sets
   `0600` permissions; the file stays plaintext in git.
5. Preview with `chezmoi diff`. Apply only when the source diff is correct and
   the user wants the live target updated now.

## Rules

- Treat the chezmoi source directory as the source of truth.
- Prefer native chezmoi patterns over ad hoc symlink or copy schemes.
- If a live target changed outside chezmoi, reconcile it back into source
  instead of patching around the generated copy.
- A one-off change to hosts that already exist, such as adding or removing one entry
  or fixing one live key, gets no reconcile machinery: no `run_once_` or
  `run_onchange_` script, retirement list entry, or declared key that only exists so a
  reconcile script carries it. Edit the live file on each affected host directly, and
  change the source only where newly seeded hosts should differ. Reconcile code is for
  state that must keep converging on every apply.
- Temporary runtime experiments are allowed only when the user explicitly asks
  for them; record how to promote the result into source.
- Resolve locations only through `chezmoi source-path` and `chezmoi managed`.
  Do not assume a source-tree path, home-directory layout, or username.

## Scripts

- Status and diff: `chezmoi status`, `chezmoi diff`.

## References

- Read `references/conventions.md` in this skill's directory when choosing file
  naming prefixes.
