// Type guards shared by the parley parsers.
export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
// The string items of an array; anything else yields an empty list.
export const strings = (input) => Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
