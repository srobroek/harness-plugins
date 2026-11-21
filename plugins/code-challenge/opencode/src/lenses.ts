/** The twelve lenses, in the order the skill lists them. Each has `lens-<id>.md` beside the skill. */
export const LENSES = [
  "simplification",
  "over-engineering",
  "optimisation",
  "performance",
  "efficiency",
  "stability",
  "hand-rolled-stdlib",
  "hand-rolled-library",
  "dead-code",
  "observability",
  "structure",
  "tests",
] as const

export type Lens = (typeof LENSES)[number]

export const PHASES = ["INTAKE", "SCAN", "CHALLENGE", "RESEARCH", "REFUTE", "DECIDE", "DELIVER"] as const

export type Phase = (typeof PHASES)[number]

export const DEPTHS = ["quick", "standard", "deep"] as const

export type Depth = (typeof DEPTHS)[number]
