// Type guards shared by the parley parsers.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The string items of an array; anything else yields an empty list.
export const strings = (input: unknown): string[] =>
  Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
