# Lens: hand-rolled code that a third-party library covers (and the reverse)

Two directions.

Forward: code that re-implements a solved problem no standard library covers (rate limiting, schema validation, diffing, semver, retry with jitter, parsing a niche format).

Reverse: a dependency that native code or a lighter library replaces; a dependency used for one function; duplicate libraries for one job; a heavy library where the standard library now suffices.

Run RESEARCH for every finding: 2 to 4 candidates scored with [library-scoring.md](library-scoring.md), plus "keep what exists" as a candidate. Evaluate partial adoption plus an extension. Hard gates are an unpatched CVE and an incompatible licence only; maintenance is a weighted signal. Record the migration cost and test protection of the call sites.

## Evidence needed

- `proven` for the facts (version, licence, CVE state, release date) with the source URL; `hypothesis` for fit until the call sites and the library's edge-case handling were read.
- `measured` for size or speed claims, with the command.

## Steering

`lang-*-libraries` (preferred libraries per language), `quality-code-policy` (a dependency the user did not name needs approval), `challenge_lib_facts` (ships in a later PR) for the facts.
