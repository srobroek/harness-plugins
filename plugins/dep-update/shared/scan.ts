import type { BumpRecord } from "@srobroek/opencode-lib/dep-bump"

const CLASS_ORDER = ["PATCH-SAFE", "MINOR-CHECK", "MAJOR-ADVISORY"]
const REPORTED = new Set(["UNRESOLVABLE", "DISCONFIRMED", "UNCHECKED"])

export type ScanSummary = { upgradable: number; skipped: number; unchecked: number }

/** The dep_scan report: upgradable bumps by class and name, then everything not classified. */
export function formatScan(records: readonly BumpRecord[], stderr: string): { text: string; summary: ScanSummary } {
  const upgradable = records.filter((record) => record.status === "OK")
  const lines: string[] = []
  for (const classification of CLASS_ORDER) {
    const bucket = upgradable.filter((record) => record.class === classification).sort((a, b) => a.name.localeCompare(b.name))
    for (const record of bucket) {
      lines.push(`${classification.padEnd(15)} ${record.name}  ${record.installed} -> ${record.latest}  (${record.ecosystem})`)
    }
  }
  for (const record of records) {
    if (!REPORTED.has(record.status)) continue
    lines.push(
      `${record.status.padEnd(15)} ${record.name}  ${record.installed} -> ${record.latest ?? "unknown"}  (${record.ecosystem}): ${record.reason ?? "not classified"}`,
    )
  }
  const unchecked = records.filter((record) => record.status === "UNCHECKED").length
  const skipped = records.length - upgradable.length - unchecked
  lines.push(`-- ${upgradable.length} upgradable, ${skipped} current/unresolvable, ${unchecked} unchecked --`)
  if (stderr.trim()) lines.push(stderr.trim())
  return { text: lines.join("\n"), summary: { upgradable: upgradable.length, skipped, unchecked } }
}
