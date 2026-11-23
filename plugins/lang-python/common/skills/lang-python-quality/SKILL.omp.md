---
name: lang-python-quality
description: Use to run Python uv lock --check, ruff, mypy or pyright, and pytest -x checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
  omp/autoinvoke: false
---
# Python Quality

Sources: [uv CLI reference](https://docs.astral.sh/uv/reference/cli/), [uv workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/), [ruff](https://docs.astral.sh/ruff/), [mypy configuration](https://mypy.readthedocs.io/en/stable/config_file.html), [pyright configuration](https://microsoft.github.io/pyright/#/configuration), [pytest exit codes](https://docs.pytest.org/en/stable/reference/exit-codes.html).

Run checks from the project root, the directory with `pyproject.toml`. Stop at the first
failure, fix it, then rerun that step. Use the project's runner: `uv run` with `uv.lock`, or
`poetry run` with `poetry.lock`.

| Step | Command |
|---|---|
| Lockfile | `uv lock --check` |
| Lint | `uv run --locked ruff check .` |
| Format check | `uv run --locked ruff format --check .` |
| Type check | `uv run --locked mypy` or `uv run --locked pyright`, as configured |
| Test | `uv run --locked pytest -x` |
| Dependencies | `uv run --locked deptry .` when configured; `uv run --locked lint-imports` when contracts exist |
| Audit | `uv run --locked pip-audit` when installed |
| API breaks | `uv run --locked griffe check PACKAGE -a REF` for a published library |
| Docs | `uv run --locked sphinx-build -W docs docs/_build` when docs exist |
| Fix | `uv run ruff check --fix PATHS`, then `uv run ruff format PATHS` when requested |

- After an edit that spans modules or changes a signature, run the configured type check once.
- `uv run` can rewrite `uv.lock`. Use `uv run --locked` in checks and CI; do not commit
  unrelated lockfile changes.
- Use the project's configured strict type-checking mode. Keep new modules clean under strict
  when the project is laxer; do not change project settings without approval.
- `pytest -x` stops at the first failure; rerun failures with `pytest --lf -x`. Narrow with
  `pytest tests/test_billing.py -k refund`.
- A pytest run that collects no tests (exit code 5) did not test anything; report it as not run.
- Fix mode on `.` rewrites unrelated files. Pass touched paths, review the diff, and revert
  incidental rewrites.

## Missing tools

Tool tables are in `lang-python-libraries` (`references/testing.md` and `references/quality.md`).
Detect tools with `uv pip show <package>`; this reads only the project environment. Without uv,
use `python -m pip show <package>` inside the project venv. If a tool is missing, recommend the
row's install command (`uv add --dev <package>`) and ask before running it. This changes
`pyproject.toml` and `uv.lock`. When the user declines, report the step as not run.

## Workspaces

For a uv workspace, one root `uv.lock` covers every member. Run `uv lock --check` once at root,
then narrow checks to the member the task touched:

```sh
uv run --locked --exact --package billing python -m pytest -x packages/billing/tests
uv run --locked --exact --package billing python -m mypy packages/billing/src
```

`--package` runs in that member's context; `--exact` removes undeclared dependencies from the
shared `.venv`. Without `--exact`, a sibling's dependency can make an invalid import pass. In a
member check, omit `--exact` when tools are declared only in the root `dev` group; say the
member dependencies were not isolated. Invoke tools as `python -m pytest`, not `pytest`, so a
missing project tool cannot fall through to a global binary.

Run the whole workspace with `uv sync --locked --all-packages` and each root check before handing
off a change to shared code.

## CI

Keep configured deptry and import contracts in the gate. Optional dead-code and security policy
is in `project-scaffold`'s `references/python.md` and `references/ci-hooks.md`: Vulture at 100%
confidence with reviewed exceptions, Ruff `C901`/`S`, complexipy at threshold 15 with a snapshot
baseline, and pip-audit for vulnerabilities. `uv audit` is report-only while it is a preview.
Ruff `F401`/`F841` do not establish whole-project reachability. Keep mypy or Pyright; pyrefly and
ty are optional advisory second checkers.

Install uv with `astral-sh/setup-uv` (`enable-cache: true`), run `uv sync --locked --all-packages`
(add `--all-groups` when checks need groups beyond `dev`), then run each tool with `uv run
--locked`. Workflow structure, the required `ci-gate` job and action pinning are in
`toolchain`'s `ci-github-actions` skill.
