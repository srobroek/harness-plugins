---
name: pitfalls
---
# Pitfalls

## Project plugin install scope

Use `omp plugin install NAME@MARKETPLACE --scope project` for a marketplace plugin owned by a
project. `omp plugin install PACKAGE` installs user-wide; the project scope flag applies only to
marketplace installs.

## Project-local skills

Project-local skill setup is not the same as a plugin install. Use the `new-project` workflow;
project skills install under `.agents/skills/<name>/` through the `agents` provider.
