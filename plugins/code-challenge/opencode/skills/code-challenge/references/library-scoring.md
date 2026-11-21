# Library scoring

Phase RESEARCH, for the two library lenses: hand-rolled code that a library replaces, and the reverse (a dependency that native code or a lighter library replaces).

Collect facts with `challenge_lib_facts` (deps.dev, OSV always fresh, the package registry, GitHub; cached for 7 days; ships in a later PR) and `context7` for API coverage. Until the tool ships, read the registry page and the OSV record with `webfetch` and cite the URL. Never score from memory.

Pick 2 to 4 candidates, including "keep the hand-rolled code" as a candidate. Evaluate partial adoption plus an extension over a full swap when the library covers most of the need.

## Gates

A candidate that trips a gate scores nothing and is listed as rejected with the reason. Only two gates exist:
1. An unpatched CVE in the version range the repository would use (OSV record with no fixed release).
2. A licence incompatible with the repository's own.

Maintenance is a weighted signal, never a gate.

## Weights

Total 100, ranked fit > compat > stability > maintained > popularity > footprint > migration.

| Criterion | Weight | Scores 0 to 1 by |
|---|---|---|
| fit | 30 | share of the needed behaviour covered, edge cases included (read the docs and issues, not the README) |
| compat | 20 | works with the repo's runtime, language version, framework and existing dependencies |
| stability | 15 | semver discipline, changelog quality, breaking-change history, 1.0 or later |
| maintained | 12 | last release inside 12 months scores at least 0.5; 12 months without a release and with open unanswered security issues scores 0 |
| popularity | 8 | downloads and dependents, relative to alternatives |
| footprint | 8 | install size, transitive dependencies, build cost |
| migration | 7 | call sites to change, test protection of those sites, API shape difference |

`score = sum(weight * value)`. Report the per-criterion values, not only the total. A candidate beats "keep" only with a margin of at least 10 points over the existing option's score and a fit of at least 0.7. Both numbers are tunable defaults: a repository or the user may set another margin or fit floor at INTAKE, and the report then states the values it used.

## Reverse direction

For each direct dependency used for one or two functions, ask whether the standard library or framework now covers it, or a lighter library does. For JavaScript, check the e18e replacement lists (`@e18e/depend` reads them). Score the same way, with "keep the dependency" as the baseline.

## Evidence

A swap claim is `measured` only when the benchmark or install-size output is in the report. A claim from registry data is `proven` for the fact (version, licence, CVE) and `hypothesis` for the fit until the call sites were read.

See `lang-*-libraries` for the repository's preferred libraries per language, and `quality-code-policy` for the rule that a dependency the user did not name needs approval.
