# Lens: tests (light, static)

A light static pass over tests that protect the challenged code. This lens never runs the suite and never rewrites tests; deep work goes to `quality-test-audit`, which stays standalone.

- missing tests for the code a finding challenges
- tests that mirror the implementation (assert on internal calls or copy the logic)
- cases that differ only in data and should be parametrised
- sleeps and fixed waits instead of conditions
- a test that cannot fail (no assertion, assertion on a constant)

Every simplification, library and structure finding already records `test_protection`; this lens covers the tests themselves.

## Evidence needed

- `proven`: the test file and line, and the quoted pattern.
- `hypothesis`: protection inferred from names only; you did not read the assertions.

## Steering

`quality-testing`, `quality-test-audit` (the deep audit; recommend it, never inline it), `lang-*-quality`.
