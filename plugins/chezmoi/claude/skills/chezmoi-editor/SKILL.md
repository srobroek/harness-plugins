---
name: chezmoi-editor
description: Edits chezmoi-managed dotfiles at their source; use when changing dotfiles, templates, or global agent and tool config.
---

# Chezmoi Editor

Use this skill when a task changes files managed by chezmoi. Resolve the managed
source first; do not edit the rendered live target of a continuously managed file as
the durable fix (live-owned targets: see Rules).

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
2. Edit the source under the chezmoi source tree, not `$HOME` runtime output, unless
   the target is live-owned (see Rules).
3. Use native chezmoi names for dotfiles, executables, private files, readonly
   files, symlinks, scripts, and templates.
4. Never write a credential in plaintext. With the 1Password CLI, read it at apply time
   with `{{ onepasswordRead "op://<vault>/<item>/<field>" }}` in a `.tmpl` file.
   chezmoi has template functions for other password managers too (Bitwarden,
   KeePassXC, `pass`, Vault and more). Use the one the user already has. Or store the
   file encrypted with `chezmoi add --encrypt <target>`, which uses the age or GPG
   `encryption` from the chezmoi config. `private_` only sets `0600` permissions, and
   the file stays plaintext in git.
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
  reconcile script carries it. This applies only to live-owned targets: seed-once
  `create_` files, and files that a reconcile script or the user owns on the host after
  seeding. Edit those live files on each affected host directly, and change the source
  only where newly seeded hosts should differ. Reconcile code is for state that must
  keep converging on every apply.
- Continuously managed files and templates are not live-owned. A host-specific change to
  one still goes in the source (use the template's host conditionals); a live edit is
  refused by the OpenCode guard and overwritten by the next `chezmoi apply`.
- Temporary runtime experiments are allowed only when the user explicitly asks
  for them; record how to promote the result into source.
- Resolve locations only through `chezmoi source-path` and `chezmoi managed`.
  Do not assume a source-tree path, home-directory layout, or username.

## Scripts

- Status and diff: `chezmoi status`, `chezmoi diff`.

## References

- Read `references/conventions.md` in this skill's directory when choosing file
  naming prefixes.
