import { type ParsedCommand, type ShellWord, type SimpleCommand, scanShell } from "@srobroek/opencode-lib/beads-shell"

/**
 * What the PR bead-link gate accepts, and what it treats as a possible `gh pr create`.
 *
 * The gate does not decode shell. It reads one exact form of `gh pr create` and refuses every
 * other command that may reach it, because a decoder has to agree with bash on every quoting,
 * expansion, wrapper and working-directory rule, and the gate loses each time they differ.
 */

/** Largest body file the gate reads, matching the cap on a whole command. */
export const MAX_BODY_BYTES = 64_000

/** Printed word for word in every refusal. */
export const ACCEPTED_FORMS = [
  "Accepted form: one command alone, `gh pr create` or `gh pr new`, with exactly one body flag:",
  "`--body V`, `--body=V` or `-b V`, or `--body-file P`, `--body-file=P` or `-F P`.",
  "P is a bare relative path without `..` or a leading `-` or `~`, in a directory that is not a symlink,",
  `to a regular UTF-8 file of at most ${MAX_BODY_BYTES} bytes without a NUL.`,
  "Flags that take a value, as a long flag (`--title V` or `--title=V`) or a short flag with a separate word (`-t V`):",
  "title -t, base -B, head -H, repo -R (OWNER/REPO), reviewer -r, assignee -a, label -l, milestone -m, project -p.",
  "Flags without a value: `--draft`/`-d`, `--no-maintainer-edit`, `--dry-run`.",
  "A word is bare (letters, digits and `_@%+=:,./-`), 'single-quoted', or \"double-quoted\" without `$`, a backtick or `\\`.",
  "Words are separated by spaces, tabs or a backslash-newline.",
  "Not accepted: operators, redirections, assignments, wrappers, substitutions, `--`, short-flag clusters,",
  "a short flag with its value attached, positional words, and the flags --fill, --web, --editor, --template, --recover and --attach.",
].join(" ")

/** The trailer rule, printed with `ACCEPTED_FORMS`. */
export const TRAILER_RULE =
  "Name the bead on a line of its own in the body: `Bead: <id>`, `Closes-Bead: <id>` or `Bead-Id: <id>`, with no other text on the line."

/** The text of a body file, or why the gate will not read it. `cause` is the error behind a failed open; it is never shown. */
export type FileRead = { ok: true; text: string } | { ok: false; reason: string; cause?: unknown }

/** Reads the `--body-file` path `P`, a bare relative path that already passed the lexical rules. */
export type ReadFile = (path: string) => FileRead

export type PrCreateRead =
  | {
      kind: "form"
      /** The body gh would submit, and where it came from, for a refusal to say what it looked at. */
      body: { text: string; source: string }
      /** The `--repo` value, an `OWNER/REPO` or `HOST/OWNER/REPO`, or null when the command names none. */
      repo: string | null
    }
  | { kind: "refused"; rule: string; cause?: unknown }

const BEAD_LINE = /^[ \t]*(?:Bead|Closes-Bead|Bead-Id):[ \t]*([A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+)[ \t]*$/i

/**
 * The bead a body names: the first line that is only a `Bead:`, `Closes-Bead:` or `Bead-Id:` key
 * and an id. The line is ASCII only, so a BOM, a no-break space or text before the key never match.
 */
export function beadIn(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const id = BEAD_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line)?.[1]
    if (id !== undefined) return id
  }
  return undefined
}

const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/
const SINGLE = /^'([^']*)'$/
const DOUBLE = /^"([^"$`\\]*)"$/
const LONG_WITH_VALUE = /^(--[A-Za-z][A-Za-z-]*)=(.+)$/s
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is exactly what this refuses
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/
const GAP = /^(?:[ \t]|\\\n)+$/
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/

/**
 * `OWNER/REPO` or `HOST/OWNER/REPO`. Each component uses GitHub's name characters and is not `.` or `..`,
 * so a repository may start with `.`, `-` or `_` (`owner/.github`). The first component never starts with
 * `-`, because the value reaches `gh repo view` as an argument.
 */
function validRepository(value: string): boolean {
  const parts = value.split("/")
  if (parts.length < 2 || parts.length > 3) return false
  if (parts[0]?.startsWith("-")) return false
  return parts.every((part) => REPOSITORY_NAME.test(part) && part !== "." && part !== "..")
}

/** The text a word stands for, or undefined when its source is not one of the three accepted shapes. */
function wordValue(span: string): string | undefined {
  if (BARE.test(span)) return span
  return SINGLE.exec(span)?.[1] ?? DOUBLE.exec(span)?.[1]
}

const BODY_FLAGS = new Set(["--body", "-b"])
const FILE_FLAGS = new Set(["--body-file", "-F"])
const VALUED_FLAGS: Record<string, string> = {
  "--title": "--title",
  "-t": "--title",
  "--base": "--base",
  "-B": "--base",
  "--head": "--head",
  "-H": "--head",
  "--repo": "--repo",
  "-R": "--repo",
  "--reviewer": "--reviewer",
  "-r": "--reviewer",
  "--assignee": "--assignee",
  "-a": "--assignee",
  "--label": "--label",
  "-l": "--label",
  "--milestone": "--milestone",
  "-m": "--milestone",
  "--project": "--project",
  "-p": "--project",
}
const BOOLEAN_FLAGS = new Set(["--draft", "-d", "--no-maintainer-edit", "--dry-run"])

const refuse = (rule: string): PrCreateRead => ({ kind: "refused", rule })

/** A flag name safe to print: the flag shapes only, cut short. */
function printable(span: string): string {
  const name = /^-{1,2}[A-Za-z][A-Za-z-]{0,40}/.exec(span)?.[0]
  return name === undefined ? "a word" : `\`${name}\``
}

/** The path rules that need no file system: bare, relative, no `..`, no leading `-` or `~`. */
function pathRule(span: string, path: string): string | undefined {
  if (span !== path) return "its path is quoted; write it as a bare word"
  if (path === "-") return "it reads the body from standard input"
  if (path.startsWith("/")) return "its path is absolute; use a relative path"
  if (path.startsWith("-") || path.startsWith("~")) return "its path starts with `-` or `~`"
  if (path.split("/").includes("..")) return "its path goes through `..`"
  return undefined
}

/**
 * Reads `source` as exactly one `gh pr create` form, or says which rule it breaks.
 * Words are judged on their raw source, so quoting, escapes and expansions are never decoded.
 */
export function readPrCreate(source: string, readFile: ReadFile): PrCreateRead {
  const text = source.replace(/^[ \t\n]+|[ \t\n]+$/g, "")
  const scan = scanShell(text)
  if (!scan.complete) return refuse("the command has an unclosed quote, substitution or here-document")
  if (scan.substitutions.length > 0) return refuse("the command holds a substitution")
  const [item, ...rest] = scan.items
  if (item === undefined || item.kind !== "command" || rest.length > 0)
    return refuse("`gh pr create` is not the only command: no operators, pipes, groups or other commands")
  if (item.redirects.length > 0 || item.hereDocuments.length > 0) return refuse("the command has a redirection")

  const words = item.words
  const spans = words.map((word) => text.slice(word.start, word.end))
  const separated = words.every((word, i) => {
    const before = words[i - 1]
    return before === undefined ? word.start === 0 : GAP.test(text.slice(before.end, word.start))
  })
  if (!separated) return refuse("the words are not separated by single spaces, tabs or backslash-newlines")
  if ((words.at(-1)?.end ?? 0) !== text.length) return refuse("the command has a comment or text after its last word")

  if (spans[0] !== "gh") return refuse("the command word is not a bare `gh`")
  if (spans[1] !== "pr" || (spans[2] !== "create" && spans[2] !== "new"))
    return refuse("the command is not `gh pr create` or `gh pr new`, as bare words")

  let body: { text: string; source: string } | undefined
  let file: { path: string; span: string } | undefined
  let bodies = 0
  let repo: string | null = null
  for (let i = 3; i < spans.length; i++) {
    const span = spans[i] as string
    if (!span.startsWith("-")) return refuse(`the word at position ${i + 1} is not a flag or a flag's value`)
    if (span === "--") return refuse("`--` is not accepted")
    const inline = LONG_WITH_VALUE.exec(span) ?? undefined
    const name = inline?.[1] ?? span
    const known = BODY_FLAGS.has(name) || FILE_FLAGS.has(name) || VALUED_FLAGS[name] !== undefined
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) continue
    if (!known) {
      const cluster = /^-[^-]/.test(span) && span.length > 2
      return refuse(
        cluster
          ? `${printable(span)} is a short flag with an attached value or a cluster; use one flag per word with a separate value`
          : `${printable(span)} is not an accepted flag`,
      )
    }
    const valueSpan = inline === undefined ? spans[++i] : inline[2]
    if (valueSpan === undefined) return refuse(`${printable(span)} has no value`)
    const value = wordValue(valueSpan)
    if (value === undefined)
      return refuse(`the value of ${printable(span)} is not a bare, 'single-quoted' or "double-quoted" word without \`$\`, a backtick or \`\\\``)
    if (CONTROL.test(value)) return refuse(`the value of ${printable(span)} holds a control character`)
    if (BODY_FLAGS.has(name)) {
      bodies++
      body = { text: value, source: "the --body text" }
    } else if (FILE_FLAGS.has(name)) {
      bodies++
      file = { path: value, span: valueSpan }
    } else if (VALUED_FLAGS[name] === "--repo") {
      if (!validRepository(value)) return refuse("the --repo value is not OWNER/REPO or HOST/OWNER/REPO")
      repo = value
    }
  }

  if (bodies === 0) return refuse("it has no --body or --body-file")
  if (bodies > 1) return refuse("it has more than one body flag")
  if (body !== undefined) return { kind: "form", body, repo }
  const named = file as { path: string; span: string }
  const lexical = pathRule(named.span, named.path)
  if (lexical !== undefined) return refuse(`--body-file: ${lexical}`)
  const read = readFile(named.path)
  if (!read.ok) return { ...refuse(`--body-file ${named.path}: ${read.reason}`), ...(read.cause === undefined ? {} : { cause: read.cause }) }
  return { kind: "form", body: { text: read.text, source: `--body-file ${named.path}` }, repo }
}

/** The values of `gh` subcommands that cannot be an alias or an extension. */
const GH_BUILTINS = new Set([
  "agent-task",
  "alias",
  "api",
  "attestation",
  "auth",
  "browse",
  "cache",
  "codespace",
  "completion",
  "config",
  "copilot",
  "discussion",
  "event",
  "extension",
  "gist",
  "gpg-key",
  "help",
  "issue",
  "label",
  "licenses",
  "org",
  "pr",
  "preview",
  "project",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "secret",
  "skill",
  "ssh-key",
  "status",
  "variable",
  "workflow",
  "--help",
  "--version",
])

const WATCHED = new Set(["gh", "pr", "create", "new"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** `env -S 'text'` and its kin hand a later word to a new shell; beyond this depth the answer is yes. */
const MAX_RESCAN_DEPTH = 4

const basename = (value: string): string => value.slice(value.lastIndexOf("/") + 1)

/** A word whose value the gate cannot know: it expands, or it is an `$'…'` or `$"…"` string. */
function opaque(word: ShellWord, text: string): boolean {
  return word.expands || /\$['"]/.test(text.slice(word.start, word.end))
}

function wordsMayCreate(values: string[], opaques: boolean[]): boolean {
  const first = values.indexOf("pr")
  if (first >= 0 && values.slice(first + 1).some((value) => value === "create" || value === "new")) return true
  const anyOpaque = opaques.some(Boolean)
  for (const [i, value] of values.entries()) {
    if (opaques[i] === true) continue
    if (basename(value) === "gh") {
      const operand = values[i + 1]
      if (operand !== undefined && !GH_BUILTINS.has(operand)) return true
    }
    if (anyOpaque && WATCHED.has(basename(value))) return true
  }
  const commandIndex = values.findIndex((value) => !ASSIGNMENT.test(value))
  // A variable or substitution in command position can name any program, `gh` included.
  if (opaques[commandIndex] === true) return true
  return false
}

/** Text the command's standard input carries: each here-document body and each here-string word. */
function stdinTexts(item: SimpleCommand, text: string): { text: string; opaque: boolean }[] {
  return [
    ...item.hereDocuments.map((document) => ({ text: document.body, opaque: false })),
    ...item.redirects.filter((word) => word.hereString === true).map((word) => ({ text: word.value, opaque: opaque(word, text) })),
  ]
}

/** Whether the text mentions `gh`, however it is spelled, or runs a command it cannot name. */
function textNamesGh(text: string): boolean {
  // An interpreter that is not a shell (`python3 <<EOF … os.system('gh pr create')`) hides the words in a string.
  if (/\bgh\b/.test(text) || /\bpr\b[\s\S]*\b(?:create|new)\b/.test(text)) return true
  const scan = scanShell(text)
  if (!scan.complete) return true
  return scan.items.some((item) => {
    if (item.kind !== "command") return false
    const opaques = item.words.map((word) => opaque(word, text))
    const first = item.words.findIndex((word) => !ASSIGNMENT.test(word.value))
    return item.words.some((word, i) => (opaques[i] !== true && basename(word.value) === "gh") || (i === first && opaques[i] === true))
  })
}

/**
 * A heredoc or here-string may reach `gh pr create` whichever command receives it: `cat <<EOF | sh`,
 * `tee >(sh) <<EOF` and a git shell alias all run it. So the text decides, never the command. It
 * counts when it may create a PR as shell, names `gh` in any spelling, has `pr` before `create` or
 * `new`, holds a command word the gate cannot read, or is an expanding here-string.
 */
function stdinMayCreate(item: SimpleCommand, text: string, depth: number): boolean {
  const documents = stdinTexts(item, text)
  if (documents.length === 0) return false
  if (depth >= MAX_RESCAN_DEPTH) return true
  return documents.some((document) => document.opaque || textMayCreate(document.text, depth + 1) || textNamesGh(document.text))
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"])
/** `-c` alone or inside a flag cluster such as `-lc` and `-ec`. */
const COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/

/**
 * The strings in one command that the shell runs again as text, so each is read as a command line:
 * every literal word after `env` (`env -S 'gh pr create'`), the script of a shell's `-c`, and the
 * literal words after `eval`, `source` and `.`, joined as `eval` joins them. A word the gate cannot
 * read is not a string it can rescan; it stays opaque.
 */
function shellTextIn(values: string[], opaques: boolean[]): string[] {
  const found: string[] = []
  const literal = (from: number): string[] => values.slice(from).filter((_, i) => opaques[from + i] !== true)
  for (const [i, value] of values.entries()) {
    if (opaques[i] === true) continue
    const name = basename(value)
    if (name === "env") found.push(...literal(i + 1))
    else if (SHELLS.has(name)) {
      const flag = values.findIndex((word, j) => j > i && opaques[j] !== true && COMMAND_FLAG.test(word))
      const script = flag < 0 || opaques[flag + 1] === true ? undefined : values[flag + 1]
      if (script !== undefined) found.push(script)
    } else if (value === "eval" || value === "source" || value === ".") {
      const words = literal(i + 1)
      if (words.length > 0) found.push(words.join(" "))
    }
  }
  return found
}

function textMayCreate(text: string, depth: number): boolean {
  const scan = scanShell(text)
  if (!scan.complete) return wordsMayCreate(text.split(/[\s'"]+/), [])
  for (const item of scan.items) {
    if (item.kind !== "command") continue
    const values = item.words.map((word) => word.value)
    const opaques = item.words.map((word) => opaque(word, text))
    if (wordsMayCreate(values, opaques)) return true
    if (stdinMayCreate(item, text, depth)) return true
    const scripts = shellTextIn(values, opaques)
    if (scripts.length === 0) continue
    if (depth >= MAX_RESCAN_DEPTH) return true
    if (scripts.some((script) => textMayCreate(script, depth + 1))) return true
  }
  return false
}

function levels(parsed: ParsedCommand): ParsedCommand[] {
  return [parsed, ...parsed.nested.flatMap(levels)]
}

/**
 * Whether any simple command at any nesting level may run `gh pr create`: the words `pr` and
 * later `create` or `new` behind any wrapper, a `gh` operand that could be an alias or extension,
 * a word the gate cannot read next to a literal `gh`, `pr`, `create` or `new`, a command word the
 * gate cannot read, a string that `env`, `sh -c`, `eval` or `source` runs again as text, or a heredoc or
 * here-string whose text trips any of those rules, whichever command receives it.
 */
export function mayCreatePr(parsed: ParsedCommand): boolean {
  return levels(parsed).some((level) => textMayCreate(level.command, 0))
}
