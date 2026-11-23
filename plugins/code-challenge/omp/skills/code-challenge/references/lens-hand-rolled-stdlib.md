# Lens: hand-rolled code that the standard library or framework covers

Find code that re-implements what the language's standard library, the runtime or the framework already ships.

- manual deep clone, debounce, retry, URL, path, date, UUID or base64 handling
- hand-written parsers for formats the stdlib reads (JSON, CSV, TOML, query strings)
- hand-built middleware, routing, validation or logging that the framework provides
- polyfills for features the minimum supported runtime already has (check the engine range)
- obsolete idioms flagged by modernisation rules (`modernize`, `UP`, `FURB`)

Check the minimum supported version before you propose a newer API. Record test protection: the replacement must keep edge-case behaviour (empty input, unicode, time zones).

## Evidence needed

- `proven`: the stdlib or framework doc URL or the `context7` result for the exact API, plus the version in which it appeared, plus a line-by-line list of the edge cases both handle.
- `hypothesis`: the API exists but an edge case differs or is undocumented.

## Steering

`lang-<language>-libraries` (the preferred standard-library and framework choices), `quality-code-policy` (standard library and framework features come before a listed library, before custom code).
