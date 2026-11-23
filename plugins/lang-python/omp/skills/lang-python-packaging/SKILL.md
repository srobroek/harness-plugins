---
name: lang-python-packaging
description: Package Python projects with uv, build backends, and workspace conventions.
---
# Python Packaging

Use uv for dependency and build management unless the project already uses another tool. Keep
`pyproject.toml` as the package configuration and commit the lockfile for applications. For
libraries, configure build metadata and test the built wheel, not only the source tree. Follow
`references/monorepo.md` for workspace layouts.
