/** Renders findings as the compact text the tool returns, and counts them. */
import { CATEGORIES, SEVERITY_ORDER } from "./model.ts";
export function countFindings(findings) {
    const counts = {
        total: findings.length,
        bySeverity: { error: 0, warn: 0, info: 0 },
        byCategory: { versions: 0, docs: 0, practices: 0, bumps: 0, consistency: 0 },
    };
    for (const finding of findings) {
        counts.bySeverity[finding.severity] += 1;
        counts.byCategory[finding.category] += 1;
    }
    return counts;
}
/** Grouped by category, then plugin; within a plugin errors come first. */
export function formatReport(findings) {
    const counts = countFindings(findings);
    const lines = [];
    for (const category of CATEGORIES) {
        const inCategory = findings.filter((finding) => finding.category === category);
        if (inCategory.length === 0)
            continue;
        lines.push(`## ${category} (${inCategory.length})`);
        const plugins = [...new Set(inCategory.map((finding) => finding.plugin))].sort();
        for (const plugin of plugins) {
            lines.push(`${plugin}`);
            const rows = inCategory
                .filter((finding) => finding.plugin === plugin)
                .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
            for (const row of rows) {
                const where = row.file === undefined ? "" : ` (${row.file})`;
                lines.push(`  ${row.severity.padEnd(5)} ${row.code}: ${row.message}${where}`);
            }
        }
    }
    if (lines.length === 0)
        lines.push("no findings");
    lines.push(`-- ${counts.total} findings: ${counts.bySeverity.error} error, ${counts.bySeverity.warn} warn, ${counts.bySeverity.info} info --`);
    return { content: lines.join("\n"), counts };
}
