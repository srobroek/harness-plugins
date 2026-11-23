/**
 * Hard gates for destructive system operations that neither cc-safety-net nor the shared OpenCode
 * gates cover (measured; README "pi"): writes to shell profiles, recursive permission changes on
 * system directories, the fork bomb, writes to raw disks, and halt/reboot/poweroff.
 *
 * Each reads the commands `walkShell` finds and the write targets `shellWriteTargets` reads, so a
 * profile that is only read (`cat ~/.zshrc`, `source ~/.zshrc`) or a hazard quoted as data passes.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { lexicalAbs, shellWriteTargets, tokenizeShell, under } from "@srobroek/opencode-lib"
import { defaultTempRoots } from "../shared/history-rewrite.ts"
import { spawnWithin } from "../shared/probes.ts"
import { base, type Command, hasFlag, positionals, walkShell } from "../shared/shell.ts"

export type SystemGateID = "shell-profile" | "system-permissions" | "fork-bomb" | "disk-write" | "power"

export const SYSTEM_GATE_IDS: readonly SystemGateID[] = ["shell-profile", "system-permissions", "fork-bomb", "disk-write", "power"]

export const SHELL_PROFILES: readonly string[] = [".zshrc", ".bashrc", ".profile", ".zprofile", ".bash_profile"]

/** Directories a recursive permission change must not reach into, whatever lies below them. */
export const SYSTEM_DIRECTORIES: readonly string[] = ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/opt", "/Applications", "/var", "/private", "/cores"]

/** Directories that are system only as themselves: what lies below them is user data. */
const SYSTEM_ROOTS: ReadonlySet<string> = new Set(["/", "/Users", "/Volumes"])

export const SYSTEM_MESSAGES: Record<SystemGateID, string> = {
  "shell-profile":
    "Blocked by safety (shell-profile-guard): this command overwrites, appends to or truncates a shell profile (~/.zshrc, ~/.bashrc, ~/.profile, ~/.zprofile or ~/.bash_profile); a bad line there breaks every new shell. Reading the profile is fine. Tell the user the exact line to add and let them edit it.",
  "system-permissions":
    "Blocked by safety (system-permissions-guard): a recursive chmod, chown or chgrp on a system directory (/, /System, /Library, /usr including /usr/local, /bin, /sbin, /etc, /opt, /Applications, /var or /private) can break the OS or Homebrew. Change the specific files you need, or hand the command to the user.",
  "fork-bomb":
    "Blocked by safety (fork-bomb-guard): this defines a shell function that starts itself through a pipe or in the background, a fork bomb that exhausts the process table. Do not run it.",
  "disk-write":
    "Blocked by safety (disk-write-guard): this command writes to a raw disk device (/dev/diskN or /dev/rdiskN), which destroys the filesystem on it. Hand disk imaging to the user.",
  power:
    "Blocked by safety (power-guard): halt, reboot and poweroff stop or restart the machine and end every session on it. Ask the user to do it.",
}

const TRUNCATE_VALUED: ReadonlySet<string> = new Set(["-s", "--size", "-r", "--reference", "-o"])

/** The files `truncate` resizes and the device `dd of=` writes, which `shellWriteTargets` does not read. */
function resizeAndCopyTargets(argv: string[]): string[] {
  const name = base(argv[0])
  if (name === "truncate" || name === "gtruncate") return positionals(argv.slice(1), TRUNCATE_VALUED)
  if (name === "dd" || name === "gdd") return argv.slice(1).flatMap((arg) => (arg.startsWith("of=") ? [arg.slice(3)] : []))
  return []
}

/** Absolute paths the call writes, in its own text and in every shell body it runs (`bash -c '…'`). */
export function writeTargets(source: string, cwd: string): string[] {
  const sources = new Set([source, ...walkShell(source).commands.map((command) => command.source)])
  return [...new Set([...sources].flatMap((text) => shellWriteTargets(text, cwd, resizeAndCopyTargets)))]
}

/** The shell profiles among `targets`. */
export function profileTargets(targets: readonly string[], home: string = homedir()): string[] {
  const profiles = new Set(SHELL_PROFILES.map((name) => join(home, name)))
  return targets.filter((target) => profiles.has(target))
}

/** The raw disk devices among `targets`: `/dev/diskN` and `/dev/rdiskN`, slices included. */
export function diskTargets(targets: readonly string[]): string[] {
  return targets.filter((target) => /^\/dev\/r?disk\d/.test(target))
}

const PERMISSION_COMMANDS: ReadonlySet<string> = new Set(["chmod", "chown", "chgrp"])

/** Whether `path` is a system directory or lies inside one, outside the temp roots. */
export function systemPath(path: string, tempRoots: readonly string[] = defaultTempRoots()): boolean {
  if (tempRoots.some((root) => under(path, root))) return false
  return SYSTEM_ROOTS.has(path) || SYSTEM_DIRECTORIES.some((dir) => under(path, dir))
}

/** A recursive `chmod`, `chown` or `chgrp` without `sudo` that reaches a system directory. */
export function systemPermissionChange(command: Command, cwd: string, tempRoots?: readonly string[]): boolean {
  if (!PERMISSION_COMMANDS.has(base(command.argv[0]))) return false
  if (command.wrappers.some((wrapper) => wrapper === "sudo" || wrapper === "doas")) return false
  const args = command.argv.slice(1)
  if (!hasFlag(args, "R", ["--recursive"])) return false
  const operands = positionals(args)
  // The first operand is the mode or owner, unless `--reference=FILE` supplies it.
  const paths = args.some((arg) => arg.startsWith("--reference")) ? operands : operands.slice(1)
  return paths.some((path) => !/[$`*?[]/.test(path) && systemPath(lexicalAbs(path, cwd), tempRoots))
}

/** `halt`, `reboot` or `poweroff` in any command position, with or without arguments. */
export function powerCommand(command: Command): boolean {
  return ["halt", "reboot", "poweroff"].includes(base(command.argv[0]))
}

/** A function whose body runs the function itself through a pipe, or twice with one in the background. */
function selfForking(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const name = words[i] as string
    const named = words[i + 1] === "(" && words[i + 2] === ")" ? i + 3 : words[i - 1] === "function" ? i + 1 : -1
    if (named < 0 || words[named] !== "{") continue
    let depth = 0
    let calls = 0
    let piped = false
    let backgrounded = false
    for (let j = named; j < words.length; j++) {
      const word = words[j] as string
      if (word === "{") depth++
      else if (word === "}" && --depth === 0) break
      else if (word === name) {
        calls++
        if (words[j + 1] === "|" && words[j + 2] === name) piped = true
        if (words[j + 1] === "&") backgrounded = true
      }
    }
    if (piped || (backgrounded && calls >= 2)) return true
  }
  return false
}

/** A fork bomb in the call's text or in a shell body it runs; a quoted mention is data. */
export function forkBomb(source: string): boolean {
  const sources = new Set([source, ...walkShell(source).commands.map((command) => command.source)])
  return [...sources].some((text) => selfForking(tokenizeShell(text).map((token) => (token.sawQuote ? "" : token.value))))
}

/**
 * Whether chezmoi manages `path`: `chezmoi source-path` exits 0 only for a managed target. No
 * chezmoi, a timeout or any other failure reads as unmanaged, so the profile gate still refuses.
 */
export async function chezmoiManages(path: string, cwd: string): Promise<boolean> {
  try {
    return (await spawnWithin(["chezmoi", "source-path", path], cwd, 3_000))?.exitCode === 0
  } catch {
    return false
  }
}

export type SystemGateOptions = {
  /** Feature ids to skip; ids of other features are ignored. */
  disabled?: ReadonlySet<string>
  home?: string
  tempRoots?: readonly string[]
  /** Whether chezmoi manages a profile; a managed one belongs to the chezmoi guard. */
  managed?: (path: string, cwd: string) => Promise<boolean>
}

export type SystemRefusal = { id: SystemGateID; reason: string }

/** The first system gate `source`, run in `cwd`, trips. */
export async function systemGate(source: string, cwd: string, options: SystemGateOptions = {}): Promise<SystemRefusal | undefined> {
  const on = (id: SystemGateID) => options.disabled?.has(id) !== true
  const refuse = (id: SystemGateID): SystemRefusal => ({ id, reason: SYSTEM_MESSAGES[id] })
  const { commands } = walkShell(source)
  if (on("fork-bomb") && forkBomb(source)) return refuse("fork-bomb")
  if (on("power") && commands.some(powerCommand)) return refuse("power")
  if (on("system-permissions") && commands.some((command) => systemPermissionChange(command, cwd, options.tempRoots)))
    return refuse("system-permissions")
  if (!on("disk-write") && !on("shell-profile")) return undefined
  const targets = writeTargets(source, cwd)
  if (on("disk-write") && diskTargets(targets).length > 0) return refuse("disk-write")
  if (on("shell-profile")) {
    const managed = options.managed ?? chezmoiManages
    for (const profile of profileTargets(targets, options.home)) if (!(await managed(profile, cwd))) return refuse("shell-profile")
  }
  return undefined
}
