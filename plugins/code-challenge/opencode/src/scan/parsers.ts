import { isAbsolute, relative, resolve } from "node:path"
import type { Hit, ParserId } from "./types.ts"

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** Parse JSON, tolerating a banner line before the first `{` or `[` (biome prints one). */
export function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === "") return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{]/)
    if (start < 0) return null
    try {
      return JSON.parse(trimmed.slice(start))
    } catch {
      return null
    }
  }
}

/** A path as the root-relative form; analyzers report absolute, cwd-relative or root-relative paths. */
export function relativeTo(root: string, file: string, cwd = root): string {
  const abs = isAbsolute(file) ? file : resolve(cwd, file)
  const rel = relative(root, abs)
  return rel === "" ? "." : rel
}

type Ctx = { root: string; cwd: string }

function biome(text: string): Hit[] {
  return arr(obj(parseJson(text)).diagnostics).flatMap((d) => {
    const diag = obj(d)
    const category = str(diag.category)
    if (!category.startsWith("lint/")) return []
    const location = obj(diag.location)
    const path = typeof location.path === "string" ? location.path : str(obj(location.path).file)
    return [{ rule: category.slice(5), file: path, line: num(obj(location.start).line), message: str(diag.message) }]
  })
}

function oxlint(text: string): Hit[] {
  return arr(obj(parseJson(text)).diagnostics).map((d) => {
    const diag = obj(d)
    const label = obj(arr(diag.labels)[0])
    return {
      rule: str(diag.code),
      file: str(diag.filename),
      line: num(obj(label.span).line),
      message: str(diag.message),
    }
  })
}

function eslint(text: string): Hit[] {
  return arr(parseJson(text)).flatMap((f) => {
    const file = obj(f)
    return arr(file.messages).map((m) => {
      const msg = obj(m)
      return { rule: str(msg.ruleId, "eslint"), file: str(file.filePath), line: num(msg.line), message: str(msg.message) }
    })
  })
}

const KNIP_KEYS = [
  "files",
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "unlisted",
  "unresolved",
  "binaries",
  "exports",
  "types",
  "duplicates",
  "enumMembers",
  "namespaceMembers",
] as const

function knip(text: string): Hit[] {
  return arr(obj(parseJson(text)).issues).flatMap((i) => {
    const issue = obj(i)
    const file = str(issue.file)
    return KNIP_KEYS.flatMap((key) =>
      arr(issue[key]).map((entry) => {
        const e = obj(entry)
        const name = str(e.name, file)
        return { rule: `knip/${key}`, file, line: num(e.line), message: `${key}: ${name}` }
      }),
    )
  })
}

function jscpd(text: string): Hit[] {
  return arr(obj(parseJson(text)).duplicates).map((d) => {
    const dup = obj(d)
    const first = obj(dup.firstFile)
    const second = obj(dup.secondFile)
    const lines = num(dup.lines) ?? 0
    return {
      rule: "duplication",
      file: str(first.name),
      line: num(first.start),
      message: `${lines} duplicated lines also in ${str(second.name)}:${num(second.start) ?? "?"}`,
    }
  })
}

function depcruise(text: string): Hit[] {
  return arr(obj(obj(parseJson(text)).summary).violations).map((v) => {
    const violation = obj(v)
    const cycle = arr(violation.cycle).map((c) => str(obj(c).name))
    const detail = cycle.length > 0 ? `${str(violation.from)} -> ${cycle.join(" -> ")}` : `${str(violation.from)} -> ${str(violation.to)}`
    return { rule: str(obj(violation.rule).name, "depcruise"), file: str(violation.from), line: null, message: detail }
  })
}

function ruff(text: string): Hit[] {
  return arr(parseJson(text)).map((d) => {
    const diag = obj(d)
    return {
      rule: str(diag.code),
      file: str(diag.filename),
      line: num(obj(diag.location).row),
      message: str(diag.message),
    }
  })
}

function vulture(text: string): Hit[] {
  const hits: Hit[] = []
  for (const line of text.split("\n")) {
    const m = /^(.+?):(\d+): (.+) \((\d+)% confidence\)$/.exec(line.trim())
    if (m) hits.push({ rule: "vulture", file: m[1] ?? "", line: Number(m[2]), message: `${m[3]} (${m[4]}% confidence)` })
  }
  return hits
}

/** Broken contracts from `lint-imports`: `<importer> is not allowed to import <imported>` then `- a -> b (l.N)`. */
function importLinter(text: string): Hit[] {
  const hits: Hit[] = []
  const broken = text.split(/^-+\nBroken contracts\n-+\n/m)[1]
  if (broken === undefined) return hits
  let contract = ""
  let heading = ""
  for (const raw of broken.split("\n")) {
    const line = raw.trimEnd()
    if (/^-+$/.test(line)) continue
    const next = /^- (\S+) -> (\S+) \(l\.(\d+)\)/.exec(line.trim())
    if (next) {
      const module = next[1] ?? ""
      hits.push({
        rule: contract || "import-linter",
        file: `${module.replaceAll(".", "/")}.py`,
        line: Number(next[3]),
        message: `${heading || `${module} imports ${next[2]}`} (${module} -> ${next[2]})`,
      })
    } else if (/ is not allowed to import /.test(line)) heading = line.replace(/:$/, "")
    else if (line !== "" && !line.startsWith(" ") && !line.startsWith("-") && !line.includes(" -> ")) contract = line
  }
  return hits
}

function golangci(text: string): Hit[] {
  return arr(obj(parseJson(text)).Issues).map((i) => {
    const issue = obj(i)
    const pos = obj(issue.Pos)
    return { rule: str(issue.FromLinter), file: str(pos.Filename), line: num(pos.Line), message: str(issue.Text) }
  })
}

function deadcode(text: string): Hit[] {
  return arr(parseJson(text)).flatMap((p) =>
    arr(obj(p).Funcs).map((f) => {
      const fn = obj(f)
      const pos = obj(fn.Position)
      return { rule: "deadcode", file: str(pos.File), line: num(pos.Line), message: `unreachable function ${str(fn.Name)}` }
    }),
  )
}

function clippy(text: string): Hit[] {
  const hits: Hit[] = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue
    const event = obj(parseJson(line))
    if (event.reason !== "compiler-message") continue
    const message = obj(event.message)
    const code = str(obj(message.code).code)
    if (code === "") continue
    const span = arr(message.spans)
      .map(obj)
      .find((s) => s.is_primary === true)
    if (!span) continue
    hits.push({ rule: code, file: str(span.file_name), line: num(span.line_start), message: str(message.message) })
  }
  return hits
}

/** `cargo machete` prints `<crate> -- <path>/Cargo.toml:` then one tab-indented dependency per line. */
function machete(text: string): Hit[] {
  const hits: Hit[] = []
  let manifest = ""
  for (const line of text.split("\n")) {
    const header = /^\S.* -- (.+Cargo\.toml):$/.exec(line)
    if (header) manifest = header[1] ?? ""
    else if (manifest !== "" && /^\s+\S+$/.test(line)) {
      hits.push({ rule: "unused-dependency", file: manifest, line: null, message: `unused dependency ${line.trim()}` })
    }
  }
  return hits
}

/** One CSV row, with quoted fields (lizard quotes its location, file and signature). */
function csvRow(row: string): string[] {
  const fields: string[] = []
  let current = ""
  let quoted = false
  for (const ch of row) {
    if (ch === '"') quoted = !quoted
    else if (ch === "," && !quoted) {
      fields.push(current)
      current = ""
    } else current += ch
  }
  fields.push(current)
  return fields
}

export const LIZARD_LIMITS = { ccn: 10, nloc: 50, params: 5 } as const

/** lizard CSV prints every function: NLOC,CCN,tokens,params,length,location,file,function,signature,start,end. */
function lizard(text: string): Hit[] {
  const hits: Hit[] = []
  for (const row of text.split("\n")) {
    const f = csvRow(row.trim())
    if (f.length < 10) continue
    const nloc = Number(f[0])
    const ccn = Number(f[1])
    const params = Number(f[3])
    if (![nloc, ccn, params].every(Number.isFinite)) continue
    const file = f[6] ?? ""
    const line = Number(f[9])
    const where = { file, line: Number.isFinite(line) ? line : null }
    const name = f[7] ?? ""
    if (ccn > LIZARD_LIMITS.ccn) hits.push({ rule: "lizard/ccn", ...where, message: `${name} has cyclomatic complexity ${ccn}` })
    if (nloc > LIZARD_LIMITS.nloc) hits.push({ rule: "lizard/nloc", ...where, message: `${name} has ${nloc} lines of code` })
    if (params > LIZARD_LIMITS.params) hits.push({ rule: "lizard/params", ...where, message: `${name} takes ${params} parameters` })
  }
  return hits
}

const PARSERS: Record<ParserId, (text: string) => Hit[]> = {
  "biome-json": biome,
  "oxlint-json": oxlint,
  "eslint-json": eslint,
  "knip-json": knip,
  "jscpd-json": jscpd,
  "depcruise-json": depcruise,
  "ruff-json": ruff,
  "vulture-text": vulture,
  "import-linter-text": importLinter,
  "golangci-json": golangci,
  "deadcode-json": deadcode,
  "clippy-json": clippy,
  "machete-text": machete,
  "lizard-csv": lizard,
}

/** Parse one analyzer's output into hits with root-relative files. */
export function parseOutput(parser: ParserId, text: string, ctx: Ctx): Hit[] {
  return PARSERS[parser](text).map((hit) => ({ ...hit, file: relativeTo(ctx.root, hit.file, ctx.cwd) }))
}
