# Lens: dead code

Find code nothing reaches.

- unused functions, exports, files, dependencies, feature flags that are always one value
- unreachable branches, commented-out code, parameters never read
- config keys nobody reads; tests for removed behaviour

Analyzer output is a lead, not proof: dynamic dispatch, reflection, framework conventions, public API and generated code hide callers. Before you call code dead, search for string references, dynamic imports, entry points in manifests, docs and other repositories that consume the package.

Scope each reachability search to the roots that can consume the code: the module's own tree, the repository's tests and scripts, and the packages that depend on it. Exclude copies that are not consumers: worktrees (`.worktrees/`, `.git/`), generated output (`dist/`, build directories, files a build copies into harness trees) and vendored code. A repository-wide search through those copies is slow and finds the code's own duplicates. When a search times out, narrow its roots and run it again; a timed-out search is a gap, never "no references".

## Evidence needed

- `proven`: the analyzer hit plus a search for every reachability path named above, each with its result.
- `hypothesis`: an analyzer hit alone, or exported API with possible external users.

## Steering

`lang-<language>-quality` (dead-code tools per language: knip, vulture, deadcode, cargo-machete), `quality-test-audit` for obsolete tests.
