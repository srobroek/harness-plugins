---
name: lang-python-profiling
description: Profile Python CPU, memory, imports, and async workloads.
---
# Python Profiling

Measure before optimizing. Use `cProfile` for CPU attribution and `tracemalloc` for Python heap
allocations. Profile representative inputs; compare the same workload and environment. For
services, check latency and throughput under load. Keep profiling dependencies out of runtime
requirements unless the product needs them.
