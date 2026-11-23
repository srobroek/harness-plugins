import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { walkShell } from "../shared/shell.ts"
import {
  diskTargets,
  forkBomb,
  profileTargets,
  SYSTEM_GATE_IDS,
  SYSTEM_MESSAGES,
  type SystemGateID,
  type SystemGateOptions,
  systemGate,
  systemPath,
  systemPermissionChange,
  writeTargets,
} from "./system-gates.ts"

const PROJECT = "/Users/me/project"
const TEMP = ["/tmp", "/private/tmp", "/private/var/folders/ab/cd/T"]
const unmanaged: SystemGateOptions = { tempRoots: TEMP, managed: async () => false }

const gate = (command: string, cwd = PROJECT, options: SystemGateOptions = unmanaged) => systemGate(command, cwd, options)

const CASES: { gate: SystemGateID; block: [string, string?][]; allow: [string, string?][] }[] = [
  {
    gate: "shell-profile",
    block: [
      ["> ~/.zshrc"],
      ["echo 'export PATH=$PATH:/opt/x/bin' >> ~/.zshrc"],
      ["echo x >> $HOME/.bashrc"],
      ["printf 'alias ll=ls\\n' | tee -a ~/.zprofile"],
      ["truncate -s0 ~/.profile"],
      ["bash -c 'echo x > ~/.bash_profile'"],
      ["cp /tmp/zshrc ~/.zshrc"],
      ["cd ~ && echo x >> .zshrc"],
    ],
    allow: [
      ["cat ~/.zshrc"],
      ["grep alias ~/.zshrc"],
      ["source ~/.zshrc"],
      ["cp ~/.zshrc /tmp/zshrc.bak"],
      ["echo '> ~/.zshrc'"],
      ["echo x >> ~/.zshrc.local"],
      ["echo x >> .zshrc"],
    ],
  },
  {
    gate: "system-permissions",
    block: [
      ["chmod -R 777 /usr/local"],
      ["chown -R nobody /usr/local"],
      ["chmod -R 755 /opt/homebrew"],
      ["chgrp -R staff /Library/Caches"],
      ["chmod -R 777 /"],
      ["chown -R me /Users"],
      ["chmod --recursive 700 /etc"],
      ["chmod -Rv 777 /System/Library"],
      ["chown -R me .", "/opt"],
      ["chmod --reference=/tmp/ref -R /usr/local/lib"],
    ],
    allow: [
      ["chmod -R u+w build"],
      ["chmod 755 /usr/local/bin/tool"],
      ["sudo chmod -R 755 /usr/local"],
      ["chmod -R 777 /tmp/work"],
      ["chmod -R 755 /private/var/folders/ab/cd/T/build"],
      ["chmod -R 700 /Users/me/project/out"],
      ['chmod -R 755 "$DIR"'],
      ["echo chmod -R 777 /"],
    ],
  },
  {
    gate: "fork-bomb",
    block: [[":(){ :|:& };:"], ["bomb(){ bomb|bomb& };bomb"], ["function f { f | f & }; f"], ["f() { f & f & }; f"], ["bash -c ':(){ :|:& };:'"]],
    allow: [["echo ':(){ :|:& };:'"], ["f() { echo hi; }; f"], ['retry() { "$@" || retry "$@"; }; retry make'], ["f() { g | f; }; f"]],
  },
  {
    gate: "disk-write",
    block: [
      ["tee /dev/disk2 < disk.img"],
      ["dd if=disk.img of=/dev/rdisk2 bs=1m"],
      ["cat disk.img > /dev/disk4s1"],
      ["sudo dd if=/dev/zero of=/dev/disk3"],
      ["gdd if=x.img of=/dev/rdisk9"],
    ],
    allow: [["dd if=/dev/disk2 of=disk.img"], ["diskutil list"], ["cat /dev/disk2"], ["echo x > /dev/null"], ["tee /dev/stderr"]],
  },
  {
    gate: "power",
    block: [["halt"], ["reboot"], ["poweroff"], ["sudo reboot"], ["sudo halt -q"]],
    allow: [["echo reboot"], ["man halt"], ["grep reboot log.txt"], ["which poweroff"]],
  },
]

for (const { gate: id, block, allow } of CASES)
  describe(id, () => {
    for (const [command, cwd] of block)
      test(`refuses ${JSON.stringify(command)}`, async () => {
        expect(await gate(command, cwd)).toEqual({ id, reason: SYSTEM_MESSAGES[id] })
      })
    for (const [command, cwd] of allow)
      test(`passes ${JSON.stringify(command)}`, async () => {
        expect(await gate(command, cwd)).toBeUndefined()
      })
    test("can be disabled", async () => {
      const [command, cwd] = block[0] as [string, string?]
      expect(await gate(command, cwd, { ...unmanaged, disabled: new Set([id]) })).toBeUndefined()
    })
  })

describe("chezmoi-managed profiles", () => {
  test("a profile chezmoi manages belongs to the chezmoi guard", async () => {
    const asked: string[] = []
    const managed = async (path: string) => (asked.push(path), true)
    expect(await gate("> ~/.zshrc", PROJECT, { ...unmanaged, managed })).toBeUndefined()
    expect(asked).toEqual([join(homedir(), ".zshrc")])
  })

  test("one unmanaged profile among managed ones still refuses", async () => {
    const managed = async (path: string) => path.endsWith(".zshrc")
    const verdict = await gate("echo x | tee ~/.zshrc ~/.bashrc", PROJECT, { ...unmanaged, managed })
    expect(verdict?.id).toBe("shell-profile")
  })
})

describe("helpers", () => {
  test("writeTargets adds truncate files and dd destinations to the shell write targets", () => {
    expect(writeTargets("truncate -s 0 a.log && dd if=x of=/dev/rdisk2", "/w")).toEqual(["/w/a.log", "/dev/rdisk2"])
    expect(writeTargets("cat a.log", "/w")).toEqual([])
  })

  test("profileTargets and diskTargets pick their paths only", () => {
    const home = "/Users/me"
    expect(profileTargets(["/Users/me/.zshrc", "/Users/me/.zshrc.bak", "/Users/me/project/.bashrc"], home)).toEqual(["/Users/me/.zshrc"])
    expect(diskTargets(["/dev/disk2", "/dev/rdisk3s1", "/dev/null", "/tmp/disk2"])).toEqual(["/dev/disk2", "/dev/rdisk3s1"])
  })

  test("systemPath covers system prefixes and exact roots, not temp or home data", () => {
    for (const path of ["/", "/usr", "/usr/local", "/opt/homebrew", "/Library", "/Users", "/private/etc"]) expect(systemPath(path, TEMP)).toBe(true)
    for (const path of ["/Users/me", "/Users/me/Library", "/tmp/x", "/private/tmp/x", "/Volumes/Backup/x"]) expect(systemPath(path, TEMP)).toBe(false)
  })

  test("systemPermissionChange reads the first operand as the mode or owner", () => {
    const [command] = walkShell("chown -R usr /Users/me/project").commands
    expect(command && systemPermissionChange(command, PROJECT, TEMP)).toBe(false)
  })

  test("forkBomb ignores a body that only names the function once", () => {
    expect(forkBomb("f() { f; }")).toBe(false)
  })

  test("every gate id has a message", () => {
    expect(Object.keys(SYSTEM_MESSAGES).sort()).toEqual([...SYSTEM_GATE_IDS].sort())
  })
})
