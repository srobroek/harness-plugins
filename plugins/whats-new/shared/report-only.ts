import { commandWords } from "../../../lib/src/command-words.ts"
import { tokenizeShell } from "../../../lib/src/shell-tokenizer.ts"

const MANIFESTS: Record<string, true> = {
  "package.json": true,
  "cargo.toml": true,
  "pyproject.toml": true,
  "go.mod": true,
  "go.sum": true,
  "requirements.txt": true,
  "composer.json": true,
  gemfile: true,
  pipfile: true,
  "package-lock.json": true,
  "npm-shrinkwrap.json": true,
  "pnpm-lock.yaml": true,
}
const LOCKFILE = /\.lock$|^bun\.lock/
const SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "\n": true, "(": true, ")": true, "$(": true }
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true }
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx"])
const PACKAGE_RUNNER_VALUE_FLAGS: ReadonlySet<string> = new Set(["-p", "--package"])
const PM_VALUE_FLAGS: Record<string, true> = {
  "--prefix": true, "-C": true, "--dir": true, "--cwd": true, "--filter": true, "-F": true, "-w": true,
  "--workspace": true, "--registry": true, "--cache": true, "--userconfig": true, "--directory": true,
  "--project": true, "--config-file": true, "--cache-dir": true,
}
const NPM_INSTALL: ReadonlySet<string> = new Set([
  "i", "in", "ins", "inst", "insta", "instal", "install", "isnt", "isnta", "isntal", "isntall", "add", "ci",
  "clean-install", "ic", "install-clean", "it", "install-test", "cit", "install-ci-test", "update", "up", "upgrade", "udpate",
])
const MUTATING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["npm", NPM_INSTALL],
  ["pnpm", new Set(["i", "install", "add", "update", "up", "upgrade", "it", "install-test"])],
  ["bun", new Set(["i", "install", "add", "update", "up", "upgrade"])],
  ["yarn", new Set(["install", "add", "up", "upgrade", "upgrade-interactive", "update"])],
  ["pip", new Set(["install"])],
  ["uv", new Set(["add", "sync"])],
  ["poetry", new Set(["add", "update", "install"])],
  ["cargo", new Set(["add", "install", "update"])],
  ["go", new Set(["get"])],
  ["bundle", new Set(["install", "update", "add"])],
  ["bundler", new Set(["install", "update", "add"])],
  ["gem", new Set(["install", "update"])],
  ["composer", new Set(["require", "update", "upgrade", "install"])],
])
const RUNNERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["npm", new Set(["exec", "x"])],
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx", "exec"])],
  ["bun", new Set(["x"])],
])
const MAX_DEPTH = 8

function subcommand(args: string[]): [string | undefined, number] {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith("-")) return [arg, i]
    if (Object.hasOwn(PM_VALUE_FLAGS, arg)) i++
  }
  return [undefined, args.length]
}

function packageRunnerCommand(args: string[]): string[] {
  let i = 0
  while (args[i]?.startsWith("-")) i += PACKAGE_RUNNER_VALUE_FLAGS.has(args[i] as string) ? 2 : 1
  return args.slice(i)
}

function simpleCommandMutates(words: string[], depth: number): boolean {
  if (depth > MAX_DEPTH) return true
  const [first, ...rest] = commandWords(words).argv
  if (first === undefined) return false
  const name = first.slice(first.lastIndexOf("/") + 1).toLowerCase()
  if (PACKAGE_RUNNERS.has(name)) return simpleCommandMutates(packageRunnerCommand(rest), depth + 1)
  if (Object.hasOwn(SHELLS, name)) {
    const flag = rest.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    const script = flag === -1 ? undefined : rest[flag + 1]
    return script !== undefined && commandMutates(script, depth + 1)
  }
  if (rest.some((arg) => arg === "--help" || arg === "-h")) return false
  if (name === "ncu" || name === "npm-check-updates") return rest.some((arg) => arg === "-u" || arg === "--upgrade")
  if (/^python\d*(?:\.\d+)*$/.test(name)) {
    const module = rest.indexOf("-m")
    return module !== -1 && rest[module + 1] === "pip" && subcommand(rest.slice(module + 2))[0] === "install"
  }
  const pm = /^pip\d*(?:\.\d+)*$/.test(name) ? "pip" : name
  const table = MUTATING.get(pm)
  if (table === undefined) return false
  const [sub, at] = subcommand(rest)
  const after = rest.slice(at + 1)
  if (sub === undefined) return pm === "yarn" && !rest.some((arg) => arg === "--version" || arg === "-v")
  if (RUNNERS.get(pm)?.has(sub)) return simpleCommandMutates(after, depth + 1)
  if (pm === "uv" && sub === "pip") {
    const [inner] = subcommand(after)
    return inner === "install" || inner === "sync"
  }
  if (pm === "uv" && sub === "lock") {
    return after.some((arg) => arg === "-U" || arg === "--upgrade" || arg === "-P" || arg.startsWith("--upgrade-package"))
  }
  return table.has(sub)
}

export function commandMutates(command: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true
  let words: string[] = []
  for (const token of tokenizeShell(command, { hereDocumentSubstitutionsOnly: true })) {
    if (token.sawQuote || !Object.hasOwn(SEPARATORS, token.value)) {
      words.push(token.value)
      continue
    }
    if (simpleCommandMutates(words, depth)) return true
    words = []
  }
  if (simpleCommandMutates(words, depth)) return true
  for (const match of command.matchAll(/`([^`]*)`|\$\(([^()]*)\)/g)) {
    if (commandMutates(match[1] ?? match[2] ?? "", depth + 1)) return true
  }
  return false
}

export function isDependencyFile(raw: string): boolean {
  const path = raw.replaceAll("\\", "/").trim()
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  return Object.hasOwn(MANIFESTS, name) || LOCKFILE.test(name)
}
