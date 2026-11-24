# Governance, forge and defaults

Ask these as one round after the shape is chosen; every answer may be "later" (leave a
visible placeholder such as `@TODO-owner`, never invent one).

## Governance round

- Owner for `CODEOWNERS`: a user or team handle (`@owner`, `@org/team`). Default `* @owner`.
- Security contact for `SECURITY.md`: email or "use the forge's private vulnerability
  reporting". Private reporting only; no public issues with exploit details.
- Conduct contact: only if given. With no working contact, omit `CODE_OF_CONDUCT.md`.
- License (`license-picker`); `none` for an unpublished or work repository, which then
  needs no `LICENSE` and, for Rust, `[licenses.private] ignore = true` in `deny.toml`.
- Public or private repository (decides issue templates, SECURITY.md wording, CodeQL).

## Forge

Ask which forge and default branch the project uses; offer GitHub and GitLab equally, and keep
an existing self-hosted hostname. For a GitHub project, use GitHub Actions and GitHub templates;
for a GitLab project, use `.gitlab-ci.yml` and `.gitlab/` issue and merge request templates,
without `.github/`. Follow the selected forge's release workflow; choose release-please,
semantic-release, or another user-selected option independently.

After you create a repository on GitHub or GitLab, ask whether to configure its merge settings.
Preserve existing repository policy. On GitHub, one optional configuration is:

```sh
gh api repos/<owner>/<repo> --method PATCH -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=COMMIT_MESSAGES
```

On GitLab, use `glab` or the GitLab API to configure the equivalent project settings after
the user approves. Verify the selected forge's supported options before changing them.

For GitHub, these settings make the squash subject the PR title and the body list the branch
commits. The `delivery-git-workflow` skill's `repo-setup-parallel-agents.md` reference,
section 6, gives the reason.

## Defaults gate

Ask once whether to use the documented defaults or customise them. Preserve existing tool versions,
installer, CI and release choices; for a new project, offer current stable pins, a 15-minute job
timeout, 512 KB large-file limit, unrestricted commit scopes, `mise install && just setup`, and
`just dev` when the project serves something. Name alternatives that fit and change only what the
user chooses. Dependency bumps afterwards are Renovate's or Dependabot's job, not an agent's.
