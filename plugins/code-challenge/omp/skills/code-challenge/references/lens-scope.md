# Lens: scope

Check the target against its design and its docs. INTAKE question 9 lists the design sources (see [intake-questions.md](intake-questions.md)). Read every source before you read the code.

Look for four kinds of gap:
- missing: a requirement or an acceptance criterion has no code, or only part of it does. A documented flag, option or error case that the code lacks counts too.
- drift: the code differs from the design or the docs. Examples: another default, another name, another error. Docs that describe behaviour the code lacks count too.
- unrequested: no design source asks for a feature, flag, endpoint, config key, command or dependency (scope creep).
- over-built: the design asks for a feature, and the code builds more. Examples: options, modes, formats or generality that the design does not name.

Keep one cause as one finding:
- over-engineering counts the implementations and callers of an abstraction. Scope compares a capability with the design. When a design source decides the question, the finding is scope. Otherwise it is over-engineering.
- dead code is unreachable. Unrequested code is reachable, but no design source asks for it.
- the seam rule in [lens-structure.md](lens-structure.md) still holds. A design source that expects more backends is a pluggability signal, so the seam is not over-built.

The design can be wrong instead of the code. Every proposal names both options:
- change the code: implement, align or remove
- change the design source to record what the code does

Removing a reachable feature sets `changes_contract`. Aligning documented behaviour sets it too.

With no design source, check the docs against the code (drift) and nothing else. Log a `blocker` line and add the gap `scope: no design source`. Report unrequested and over-built candidates as `hypothesis` at most.

## Evidence needed

- `proven`: quote the design line (`path:line`, or the bead id and field) beside the code locator. For a missing item, list the searches that found no implementation, each with its command and result. For unrequested code, list the searches of every design source that found no mention.
- `hypothesis`: the design is silent or ambiguous, the code is newer than the design, or the README is the only source. Say which, and quote what the source says.

## Steering

`quality-code-policy` (YAGNI, research-first reuse), `architecture-guide` for the documented architecture.
