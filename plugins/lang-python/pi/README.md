# lang-python

Python skills: the lock, lint, type-check and test commands to run through the shell
tool and in CI, how to report a step that could not run, pytest and Hypothesis idioms,
package layout, typing and pydantic boundary models, SQLAlchemy and Alembic, and the
profiler and benchmark tooling. Formatting is OpenCode's built-in formatter (`"formatter": true`); see
[docs/formatters.md](../../docs/formatters.md).

Replaces the Python half of the former `languages` plugin, which ported the omp-plugins
`python` plugin (its `python_quality` tool is not ported).

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/lang-python/opencode'
```

Claude Code install the same skills from this repository's marketplace:

```sh
claude plugin install lang-python@harness-plugins
```

## Skills

Only `lang-python` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code ignores that metadata, so there every skill is listed and triggers directly.
The profiling skill is also reached through the `quality` plugin's `quality-profiling` skill.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `lang-python`: the router.
- `lang-python-libraries`: compare library defaults before writing code for services,
  data, messaging, AWS, MCP, telemetry, CLI, testing and security.
- `lang-python-quality`: lockfile checks, configured lint and format tools (Ruff defaults), mypy or
  pyright strict, and the configured test runner (pytest default), in that order; uv workspace narrowing and CI.
- `lang-python-testing`: pytest fixtures, parametrize, monkeypatch, Hypothesis, coverage;
  `references/practice.md` has tool choices, bad tests with fixes, and defaults by use case.
- `lang-python-packaging`: src layout, `__init__` facades and `__all__`, import-linter,
  uv workspaces, PEP 735 dependency groups.
- `lang-python-types`: mypy and pyright strict, typing idioms, pydantic v2 boundary
  models, datamodel-codegen.
- `lang-python-persistence`: SQLAlchemy sessions and `rowcount` compare-and-set, Alembic
  autogenerate review, single-head CI check, in-memory SQLite with the real migrations.
- `lang-python-profiling`: py-spy, `profiling.sampling`, scalene, memray, cProfile, pyperf.
  The method is the `quality` plugin's `quality-profiling` skill.
