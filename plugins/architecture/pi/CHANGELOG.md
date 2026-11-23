## architecture [0.11.1](https://github.com/srobroek/harness-plugins/compare/architecture--v0.11.0...architecture--v0.11.1) (2026-11-23)

### Bug Fixes

* **whats-new:** grant MCP tools to the whats-new research agent ([8ae7fe0](https://github.com/srobroek/harness-plugins/commit/8ae7fe05c65e2df2f53ebf944c8f9bd5b7625cf9))

## architecture [0.11.0](https://github.com/srobroek/harness-plugins/compare/architecture--v0.10.0...architecture--v0.11.0) (2026-11-23)

### Features

* **agent-plugins:** complete pi agent prompts ([bd49ec4](https://github.com/srobroek/harness-plugins/commit/bd49ec4a310c315702f2ce63789cda4cf345760d))

## architecture [0.10.0](https://github.com/srobroek/harness-plugins/compare/architecture--v0.9.1...architecture--v0.10.0) (2026-11-23)

### Features

* **agent-reviewer:** ship agent-only plugins to OMP ([4651445](https://github.com/srobroek/harness-plugins/commit/4651445bd2b5ce547a1bf781c7049acf4f894019))

## architecture [0.9.1](https://github.com/srobroek/harness-plugins/compare/architecture--v0.9.0...architecture--v0.9.1) (2026-11-23)

### Bug Fixes

* make every plugin agent's OMP form correct ([96b7bfe](https://github.com/srobroek/harness-plugins/commit/96b7bfea3c35017b34a28f59e81fb059f6c68a24))

## architecture [0.9.0](https://github.com/srobroek/harness-plugins/compare/architecture--v0.8.1...architecture--v0.9.0) (2026-11-22)

### Features

* **delivery:** ship the orchestrator agent ([#121](https://github.com/srobroek/harness-plugins/issues/121)) ([53f33c0](https://github.com/srobroek/harness-plugins/commit/53f33c016315732220a7c87066267931ee87f514))

## architecture [0.8.1](https://github.com/srobroek/harness-plugins/compare/architecture--v0.8.0...architecture--v0.8.1) (2026-11-21)

### Bug Fixes

* **code-challenge:** close dogfood friction in skill, schema and validation ([043a8b3](https://github.com/srobroek/harness-plugins/commit/043a8b39057ec8fca54d09adebb0532c2154e330))

## architecture [0.8.0](https://github.com/srobroek/harness-plugins/compare/architecture--v0.7.0...architecture--v0.8.0) (2026-11-21)

### Features

* **architecture:** give the architect the read-only shell ([0dc1a97](https://github.com/srobroek/harness-plugins/commit/0dc1a9782229c62b254e96bd5624110ff43ad51c))

### Bug Fixes

* **architecture:** rebuild with the hardened read-only shell rules ([1d623b8](https://github.com/srobroek/harness-plugins/commit/1d623b88696750f9a4bdacea61feaf45d1f4ed39))

# Changelog

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.6.0...architecture--v0.7.0) (2026-11-20)


### Features

* **agents:** follow lang skills and the repo engineering doc, report departures ([#267](https://github.com/srobroek/opencode-plugins/issues/267)) ([2c15755](https://github.com/srobroek/opencode-plugins/commit/2c15755d62faed398c8f3ce4747a61d1c92ff00c))
* **architecture:** allow the aws-guidance skill to architect ([7cbfa12](https://github.com/srobroek/opencode-plugins/commit/7cbfa12f297118f9704e521225cb2c593154030e))
* **architecture:** allow toolchain skills ([0055f1c](https://github.com/srobroek/opencode-plugins/commit/0055f1c14530c56aee695f212816e2f9bc62d2f4))
* **architecture:** carry coding-core standards in the architect prompt ([7155a6b](https://github.com/srobroek/opencode-plugins/commit/7155a6bfbe84b7663814329ed8bea1512b19aa23))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **plugin-audit:** add plugin_audit_scan tool and plugin-audit skill ([d400433](https://github.com/srobroek/opencode-plugins/commit/d4004330e9a922d8e832b6f3266502141eaea4a3))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.5.0...architecture--v0.6.0) (2026-11-19)


### Features

* beads, speckit and journeys in Claude Code; translated subagents instead of raw OpenCode agents ([e5fcc23](https://github.com/srobroek/opencode-plugins/commit/e5fcc2338e0846cbebc3370f65826cf2edf137bc))
* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.4.0...architecture--v0.5.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.3.0...architecture--v0.4.0) (2026-11-12)


### Features

* **quality:** research-first engineering standards and per-language library standards for every coding agent ([09e8d46](https://github.com/srobroek/opencode-plugins/commit/09e8d461bb2b7654788a588ef6932929ff564d28))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.2.1...architecture--v0.3.0) (2026-11-11)


### Features

* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.2.0...architecture--v0.2.1) (2026-10-27)


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))


### Performance

* **architecture:** drop Code Mode and allow skills by family ([83f757a](https://github.com/srobroek/opencode-plugins/commit/83f757a1a830697ca8010814b49b0af28bf840bb))
* **architecture:** trigger the router on mapping components and monorepo layout ([fdc250e](https://github.com/srobroek/opencode-plugins/commit/fdc250e3cfcae6607e9d80e5a06d6bb5a1d008e9))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.1.0...architecture--v0.2.0) (2026-10-27)


### Features

* **architecture:** add architecture skills and read-only architect agent ([5e46e6e](https://github.com/srobroek/opencode-plugins/commit/5e46e6e8ea2ecb27e1c1def7db9ba0c3f7a5c4a7))
* **architecture:** declare the architect model role ([b2dc547](https://github.com/srobroek/opencode-plugins/commit/b2dc5472127b214e0c5d29fcbea653366e3ae2c8))
* **lib:** carry steps and the model-role header from shipped agent files ([7538ab1](https://github.com/srobroek/opencode-plugins/commit/7538ab1a05b3071564defb2ab11ce356245c3890))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))


### Performance

* **architecture:** route the three architecture skills through one architecture-guide listing entry ([44a463b](https://github.com/srobroek/opencode-plugins/commit/44a463b774d7ed64009869ea7b39d249fde9dfe0))
* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* keep shipped agent descriptions under 150 characters ([7023675](https://github.com/srobroek/opencode-plugins/commit/70236752520b0fd02b872ec61510ec1388028778))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
