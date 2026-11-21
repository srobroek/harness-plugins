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

/**
 * - `absent`: nothing is at the path.
 * - `unreadable`: something is there but it is not a regular non-symlink file (`not-regular`,
 *   which includes a FIFO or device), it is larger than the limit (`too-large`), or reading failed (`io`).
 * - `bytes`: the whole file, at most `maxBytes` long.
 */
export type BoundedBytes =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: "not-regular" | "too-large" | "io" }
  | { kind: "bytes"; bytes: Buffer }

/**
 * Read a regular, non-symlink file of at most `maxBytes` without ever blocking or over-allocating:
 * `lstat` rejects a FIFO, device or symlink before it is opened, the open is `O_NOFOLLOW |
 * O_NONBLOCK`, and `fstat` on the descriptor re-checks the type and the size before any buffer is
 * allocated, so a file swapped in after the `lstat` is caught too.
 */
export function readBoundedBytes(path: string, maxBytes: number): BoundedBytes {
  let fd: number | undefined
  try {
    if (!lstatSync(path).isFile()) return { kind: "unreadable", reason: "not-regular" }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile()) return { kind: "unreadable", reason: "not-regular" }
    if (info.size > maxBytes) return { kind: "unreadable", reason: "too-large" }
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return { kind: "bytes", bytes: offset === buffer.length ? buffer : buffer.subarray(0, offset) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { kind: "absent" }
    // O_NOFOLLOW on a symlink fails with ELOOP.
    return { kind: "unreadable", reason: code === "ELOOP" ? "not-regular" : "io" }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readBounded(path: string): BoundedRead {
  const read = readBoundedBytes(path, MAX_LEDGER_FILE_BYTES)
  if (read.kind === "absent") return { kind: "absent" }
  return read.kind === "bytes" ? { kind: "text", text: read.bytes.toString("utf8") } : { kind: "unreadable" }
}

/** The text of a small regular file, or undefined for anything else. Diagnostics only. */
export function readSmallRegularFile(path: string): string | undefined {
  const read = readBounded(path)
  return read.kind === "text" ? read.text : undefined
}
