## ast-grep [1.3.2](https://github.com/srobroek/harness-plugins/compare/ast-grep--v1.3.1...ast-grep--v1.3.2) (2026-11-23)

### Bug Fixes

* **whats-new:** grant MCP tools to the whats-new research agent ([8ae7fe0](https://github.com/srobroek/harness-plugins/commit/8ae7fe05c65e2df2f53ebf944c8f9bd5b7625cf9))

## ast-grep [1.3.1](https://github.com/srobroek/harness-plugins/compare/ast-grep--v1.3.0...ast-grep--v1.3.1) (2026-11-23)

### Bug Fixes

* make every plugin agent's OMP form correct ([96b7bfe](https://github.com/srobroek/harness-plugins/commit/96b7bfea3c35017b34a28f59e81fb059f6c68a24))

## ast-grep [1.3.0](https://github.com/srobroek/harness-plugins/compare/ast-grep--v1.2.1...ast-grep--v1.3.0) (2026-11-22)

### Features

* **delivery:** ship the orchestrator agent ([#121](https://github.com/srobroek/harness-plugins/issues/121)) ([53f33c0](https://github.com/srobroek/harness-plugins/commit/53f33c016315732220a7c87066267931ee87f514))

## ast-grep [1.2.1](https://github.com/srobroek/harness-plugins/compare/ast-grep--v1.2.0...ast-grep--v1.2.1) (2026-11-21)

### Bug Fixes

* **code-challenge:** close dogfood friction in skill, schema and validation ([043a8b3](https://github.com/srobroek/harness-plugins/commit/043a8b39057ec8fca54d09adebb0532c2154e330))

# Changelog

## [1.2.0](https://github.com/srobroek/opencode-plugins/compare/ast-grep--v1.1.0...ast-grep--v1.2.0) (2026-11-20)


### Features

* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [1.1.0](https://github.com/srobroek/opencode-plugins/compare/ast-grep--v1.0.0...ast-grep--v1.1.0) (2026-11-12)


### Features

* **quality:** research-first engineering standards and per-language library standards for every coding agent ([09e8d46](https://github.com/srobroek/opencode-plugins/commit/09e8d461bb2b7654788a588ef6932929ff564d28))

## [1.0.0](https://github.com/srobroek/opencode-plugins/compare/ast-grep--v0.2.0...ast-grep--v1.0.0) (2026-11-10)


### ⚠ BREAKING CHANGES

* **ast-grep:** the plugin no longer registers the ast-grep MCP server or reads the mcp option; agents run the ast-grep CLI through the shell.

### Features

* **ast-grep:** drop the MCP server for the CLI; add Semgrep, Serena and rust-analyzer guidance ([42c0b1c](https://github.com/srobroek/opencode-plugins/commit/42c0b1cf599bdf95611e06455afb3298c1f70bd5))


### Documentation

* **ast-grep:** add max_results, kind-with-regex, Rust macro and Go call gotchas ([b5fa7a8](https://github.com/srobroek/opencode-plugins/commit/b5fa7a8e7800c064559c1189a1ee34b828b4efb1))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/ast-grep--v0.1.0...ast-grep--v0.2.0) (2026-10-27)


### Features

* **ast-grep:** add the ast-grep MCP server, gated on the ast-grep binary, and the ast-grep-search skill ([a89994a](https://github.com/srobroek/opencode-plugins/commit/a89994adf07cb25fed98662407c5eaa2615d9693))
