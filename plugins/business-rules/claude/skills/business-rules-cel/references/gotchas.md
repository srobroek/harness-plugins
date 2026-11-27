# Gotchas for every engine

These hold for every CEL engine in the standard. Each one names the case in `business-rules-testing` that
catches it. Sources: the cel-spec language definition (<https://github.com/google/cel-spec/blob/master/doc/langdef.md>),
and the 2026-11 engine spike.

## Numbers are strict

- CEL has `int`, `uint` and `double`, and no automatic arithmetic conversion. `1 + 1.0` and `1 + 1u` fail with
  "no matching overload".
- Write a double literal with a decimal point (`0.5`, `1.0`) when you compare it with a `double` field. Convert
  with `int()`, `uint()` or `double()` when you must mix them.
- Comparing an `int` with a `double` checks only when the profile enables `cross_type_numeric_comparisons`. Keep
  that option off unless every engine enforces it. An evaluator that does not check (@bufbuild/cel) evaluates the
  comparison anyway.
- At runtime, equality between values of different non-numeric types is `false`, not an error.
  `decision.status == 1` (a string against an int) is caught only by a checker that follows cel-go. cel-core's
  checker accepts it. Numbers compare by value across types: unchecked, `1.0 == 1` is `true`.
- Test: a reject case for each mixed-type operation the rules are likely to contain.

## `has()` and default values

- In a protobuf-typed scope, selecting a field that is not set reads its default value. It is not an error. In
  Kubernetes, which evaluates over untyped maps, the same read is a `no such key` error. Do not port rules
  between the two without new presence cases.
- `has()` on a required scalar at its zero value is `false`, so it cannot mean "present". Use `has()` only on
  optional and nullable fields (the presence lint of G2).
- Test: the presence cases, for every kind and every state.

## Wrappers

- A nullable scalar is a `google.protobuf.*Value` wrapper. When it is absent it reads `null`, and arithmetic on
  it is an evaluation error.
- Guard it with `has(x.f)` or `x.f != null` before you compute with it.
- An engine that types a wrapper as `dyn` loses its type errors. @marcbachmann/cel-js does this.
- Test: the presence cases for the nullable kind, and a reject case for a wrapper in a wrong-type operation.

## Errors are values, not exceptions

- An evaluation error is a CEL value. The host's call does not raise: cel-expr-python returns a value whose
  type is `ERROR`, and cel-go returns an error value with its error. Test for it on every result.
- `&&` and `||` are commutative over errors. When one operand decides the result (`false` for `&&`, `true` for
  `||`), an error in the other operand is ignored. So `false && 1 / 0 == 1` is `false`, and the error disappears.
- A rule that evaluates to an error never counts as a pass. Record it as a failure to evaluate, with an unknown
  result (G1, P4).
- Test: a case per rule slot whose activation makes the rule fail to evaluate, and that expects "unknown".

## Enum values are strings

- A JSON Schema `enum` of strings becomes a CEL `string`. The checker does not know the allowed values, so
  `decision.status == "aproved"` checks and is always `false`.
- G1's enum lint compares each string literal with the enum of the field it is compared to.
- Test: a lint case with a misspelt enum literal.

## `size()` on strings counts code points

- `size(s)` on a `string` is the number of Unicode code points, not bytes and not grapheme clusters. `size(b)` on
  `bytes` counts bytes.
- JSON Schema `maxLength` also counts code points, so the two agree. A host language's own length function may
  not agree (UTF-16 units in JavaScript, bytes in Go and Rust).
- Test: an accept case with a non-ASCII string at the limit.

## Time zones

- Timestamp accessors (`getHours()`, `getDayOfWeek()`, `getDate()` and the rest) use UTC by default. With a time
  zone argument they take a fixed offset (`"+01:00"`) or a zone name (`"Europe/Amsterdam"`).
- A zone name needs the engine's time zone database, and engines bundle different versions of it. The spike did
  not test zone names across engines.
- Local time has gaps and repeats. On the day clocks move forward, the local hour 02 does not occur in many
  European zones. On the day they move back, it occurs twice. A rule such as
  `t.getHours("Europe/Amsterdam") == 2` never matches on the first day and matches two hours of instants on the
  second.
- Compare instants (timestamps and durations) in portable rules. Use a zone name only where the rule really is
  about local time, and add cases on both transition days.
- Test: cases on both transition days of each zone that the rules name, run on every engine.

## Extension versions

- Extensions are the main source of difference between engines. Enable only those that every executing engine
  has. With @bufbuild/cel in the set, that is the strings extension alone.
- Engines number versions differently. cel-go declares `cel.@block` in bindings version 1. cel-cpp's environment
  config, which cel-expr-python uses, has no bindings version 1.
- cel-go's extension factory accepts a version that does not exist. Each adapter keeps its own inventory and
  refuses any other version at load (G4).
- An engine without a version switch (cel-cpp, cel-core, @bufbuild/cel) cannot prove which version it
  implements. Its inventory lists the versions whose functions the suite exercised on it.
- Test: the effective-environment cases, and an unknown-version case per adapter.
