# Lens: performance (measured)

Findings here need a measurement. A suspicion without one stays a hypothesis and goes to [lens-optimisation.md](lens-optimisation.md) or [lens-efficiency.md](lens-efficiency.md) as that lens's finding.

- slow endpoints, builds, tests or start-up named by the user or by CI timings
- allocation hot spots, lock contention, blocking calls on an async path, serial I/O that can overlap
- bundle or binary size growth

Method: reproduce the cost, profile, name the top frame, estimate the best-case gain from that frame, then propose. Run benchmarks only when INTAKE allowed them (interactive asks once; autonomous allows them at standard and deep). Never run a benchmark against production or shared services.

## Evidence needed

- `measured` only: the command, the numbers before, and the noise (repeat runs or the tool's confidence interval). A single run is a `hypothesis`.
- State the machine and load conditions; a loaded laptop skews numbers.

## Steering

`quality-profiling` (method), `lang-go-profiling`, `lang-python-profiling`, `lang-rust-profiling`, `lang-typescript-profiling` (tools per language).
