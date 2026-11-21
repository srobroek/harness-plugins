/**
 * Bounded reads of repository-controlled files.
 *
 * A ledger's `metadata.json` and `config.yaml` live in the working tree, so a commit can
 * make them a symlink to `/dev/zero`, a FIFO or a huge file. Reading one unbounded
 * exhausts memory or stalls the host, so every ledger read goes through here.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"

/** Ledger metadata is a few lines; anything bigger is not read. */
export const MAX_LEDGER_FILE_BYTES = 64 * 1024

/**
 * - `absent`: nothing is at the path.
 * - `unreadable`: something is there, but it is not a small regular non-symlink file
 *   (or reading it failed), so its content cannot be trusted or even read safely.
 */
export type BoundedRead = { kind: "absent" } | { kind: "unreadable" } | { kind: "text"; text: string }

export function readBounded(path: string): BoundedRead {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) return { kind: "unreadable" }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_LEDGER_FILE_BYTES) return { kind: "unreadable" }
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return { kind: "text", text: buffer.toString("utf8", 0, offset) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The text of a small regular file, or undefined for anything else. Diagnostics only. */
export function readSmallRegularFile(path: string): string | undefined {
  const read = readBounded(path)
  return read.kind === "text" ? read.text : undefined
}

// A failure keeps the fs error code, so a caller can tell ENOENT from EACCES.
export type BoundedFile = { kind: "text"; text: string } | { kind: "failed"; reason: string }

// Read a regular, non-symlink file of at most maxBytes. Unlike readBounded the cap is the caller's and a
// failure says why. It never blocks on a FIFO: lstat first, then O_NONBLOCK | O_NOFOLLOW.
export function readBoundedFile(path: string, maxBytes: number): BoundedFile {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) return { kind: "failed", reason: "not a regular file" }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile()) return { kind: "failed", reason: "not a regular file" }
    if (info.size > maxBytes) return { kind: "failed", reason: `larger than ${maxBytes} bytes` }
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return { kind: "text", text: buffer.toString("utf8", 0, offset) }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    const message = (failure.message ?? String(error)).split(",")[0] ?? ""
    return { kind: "failed", reason: message }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
