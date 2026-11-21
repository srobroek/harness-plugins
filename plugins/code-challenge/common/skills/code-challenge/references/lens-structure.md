# Lens: structure

Find code organised in a way that hurts change.

- duplication of knowledge that changes together (not merely similar text)
- coupling: modules that know each other's internals; dependency cycles; wrong dependency direction
- cohesion: a module that does unrelated jobs; god modules and god classes; long parameter lists that hide a missing type
- boundaries: layers crossed, domain code that imports transport or storage
- naming that misleads

## Abstraction seams

Where the product expects pluggable code, frequent change, or more backends or providers, flag business logic tied directly to one backend: SDK calls, database clients, HTTP clients or provider APIs scattered through the domain. Propose the right seam: a port and adapter interface, the framework's middleware (Hono, ASGI, tower or `net/http` wrappers), or a standard abstraction library.

Whether pluggability is expected is a product question. INTAKE asks it in interactive mode; autonomous mode infers it from signals (see [intake-questions.md](intake-questions.md)) and logs the inference to `decisions.jsonl`. With no signal, extra abstraction is an over-engineering finding in [lens-over-engineering.md](lens-over-engineering.md), never a gap here. The two lenses share this rule so they never contradict each other.

Record test protection. Hand deep restructuring to the refactor mode of the coder after approval.

## Evidence needed

- `proven`: the import graph, a duplication count with locations, or a cycle listing, from a tool or from `grep` output.
- `hypothesis`: a judgement about cohesion or naming. Name the signal that would change your mind.

## Steering

`architecture-guide`, `architecture-ownership`, `quality-code-policy`, `lang-*-quality`.
