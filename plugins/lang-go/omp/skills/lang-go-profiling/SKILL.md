---
name: lang-go-profiling
description: Profile Go CPU, memory, goroutines, and contention.
---
# Go Profiling

Measure before optimizing. Use `go test -bench` for representative benchmarks and collect CPU or
heap profiles with `-cpuprofile` or `-memprofile`. Inspect profiles with `go tool pprof`. For
services, expose pprof only on a protected administrative endpoint. Compare with the same inputs
and toolchain.
