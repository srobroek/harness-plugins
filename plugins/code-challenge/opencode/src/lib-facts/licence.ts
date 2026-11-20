/** SPDX ids a dependency may carry without tripping the licence hard gate: permissive and weak copyleft. */
export const ALLOWED_LICENCES: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "Zlib",
  "BlueOak-1.0.0",
  "Python-2.0",
  "PSF-2.0",
  "MPL-2.0",
  "EPL-2.0",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
])

/** One SPDX expression: `OR` is a choice, `AND` needs both sides, `WITH` exceptions are ignored. */
function expressionAllowed(expression: string): boolean {
  const alternatives = expression.replace(/[()]/g, " ").split(/\s+OR\s+/i)
  return alternatives.some((alternative) =>
    alternative.split(/\s+AND\s+/i).every((id) => ALLOWED_LICENCES.has(id.trim().replace(/\s+WITH\s+.*$/i, ""))),
  )
}

/**
 * The licence gate: `true` when a licence is outside {@link ALLOWED_LICENCES}, `null` when
 * none is known. Every listed licence must pass; a non-SPDX value fails.
 */
export function licenceBlocked(licences: readonly string[] | null): boolean | null {
  if (licences === null || licences.length === 0) return null
  return !licences.every(expressionAllowed)
}
