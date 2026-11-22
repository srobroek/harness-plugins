import parse from "spdx-expression-parse";
/** SPDX ids a dependency may carry without tripping the licence hard gate: permissive and weak copyleft. */
export const ALLOWED_LICENCES = new Set([
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
]);
/** `OR` needs one side to pass, `AND` both. A `WITH` exception does not change the licence's own verdict. */
function satisfied(node) {
    if ("conjunction" in node)
        return node.conjunction === "or" ? satisfied(node.left) || satisfied(node.right) : satisfied(node.left) && satisfied(node.right);
    return ALLOWED_LICENCES.has(node.license);
}
/** One SPDX expression, with grouping. An expression that does not parse is not allowed. */
export function expressionAllowed(expression) {
    try {
        return satisfied(parse(expression));
    }
    catch {
        return false;
    }
}
/**
 * The licence gate: `true` when a licence is outside {@link ALLOWED_LICENCES}, `null` when
 * none is known. Every listed licence must pass; a non-SPDX value fails.
 */
export function licenceBlocked(licences) {
    if (licences === null || licences.length === 0)
        return null;
    return !licences.every(expressionAllowed);
}
