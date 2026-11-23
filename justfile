# Task runner. Each recipe wraps a package.json script, so `bun run <script>` and `just <recipe>` agree.
# `just verify` runs what CI runs.

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

install:
    bun install --frozen-lockfile

build:
    bun run build

build-check:
    bun run build:check

check:
    bun run check

test:
    bun run test

typecheck:
    bun run typecheck

lint:
    bun run lint

plugin-table:
    bun run plugin-table

plugin-table-check:
    bun run plugin-table:check

steering:
    bun run steering

pitfalls:
    bun run pitfalls

agent-roles:
    bun run agent-roles

descriptions:
    bun run descriptions

concerns:
    bun run concerns


release:
    bun run release

# Previews the releases the commits on this branch would cut. Tags, publishes and pushes nothing.
release-dry-run:
    bun run release -- --dry-run --branches "$(git branch --show-current)"

# Make the delivery bundle stale, run its release prepare step, and fail if it stays stale.
release-prepare-check:
    bun scripts/check-release-prepare.ts

test-executables:
    bun scripts/check-test-executables.ts

# Python unit tests of the shipped scripts.
python-tests:
    for dir in plugins/beads/common/skills/beads-preflight plugins/worktrunk/common/skills/worktrunk-preflight; do python3 -B -m unittest discover -s "$dir" -p 'test_*.py' -v; done

# Everything CI runs: the `check` job (harness-kit check, tests, tsc) and the `repo-checks` job.
verify: typecheck lint test build-check check plugin-table-check steering pitfalls agent-roles descriptions concerns test-executables release-prepare-check python-tests
