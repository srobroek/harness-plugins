import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs"
import { join } from "node:path"

/** Create `segments` below `base` one real directory at a time; a symlink or file in the way is refused. */
export function ensureDir(base: string, ...segments: string[]): string {
  let current = base
  for (const segment of ["", ...segments]) {
    current = segment === "" ? base : join(current, segment)
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    if (!lstatSync(current).isDirectory()) throw new Error(`challenge_scan: refusing to use ${current}: not a real directory`)
  }
  return current
}

/** Write a private file, replacing a regular file but never following a symlink at `path`. */
export function writeFileNoFollow(path: string, data: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, data)
  } finally {
    closeSync(fd)
  }
}
