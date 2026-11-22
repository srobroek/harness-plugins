/**
 * Bounded reads of repository-controlled files.
 *
 * A ledger's `metadata.json` and `config.yaml` live in the working tree, so a commit can
 * make them a symlink to `/dev/zero`, a FIFO or a huge file. Reading one unbounded
 * exhausts memory or stalls the host, so every ledger read goes through here.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
/** Ledger metadata is a few lines; anything bigger is not read. */
export const MAX_LEDGER_FILE_BYTES = 64 * 1024;
/**
 * Read a regular, non-symlink file of at most `maxBytes` without ever blocking or over-allocating:
 * `lstat` rejects a FIFO, device or symlink before it is opened, the open is `O_NOFOLLOW |
 * O_NONBLOCK`, and `fstat` on the descriptor re-checks the type and the size before any buffer is
 * allocated, so a file swapped in after the `lstat` is caught too.
 */
export function readBoundedBytes(path, maxBytes) {
    let fd;
    try {
        if (!lstatSync(path).isFile())
            return { kind: "unreadable", reason: "not-regular" };
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = fstatSync(fd);
        if (!info.isFile())
            return { kind: "unreadable", reason: "not-regular" };
        if (info.size > maxBytes)
            return { kind: "unreadable", reason: "too-large" };
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
            const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (read === 0)
                break;
            offset += read;
        }
        return { kind: "bytes", bytes: offset === buffer.length ? buffer : buffer.subarray(0, offset) };
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return { kind: "absent" };
        // O_NOFOLLOW on a symlink fails with ELOOP.
        return code === "ELOOP" ? { kind: "unreadable", reason: "not-regular" } : { kind: "unreadable", reason: "io", code };
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** `maxBytes` defaults to the ledger bound; callers with a different bound pass their own. */
export function readBounded(path, maxBytes = MAX_LEDGER_FILE_BYTES) {
    const read = readBoundedBytes(path, maxBytes);
    if (read.kind === "absent")
        return { kind: "absent" };
    return read.kind === "bytes" ? { kind: "text", text: read.bytes.toString("utf8") } : { kind: "unreadable" };
}
/** The text of a small regular file, or undefined for anything else. Diagnostics only. */
export function readSmallRegularFile(path) {
    const read = readBounded(path);
    return read.kind === "text" ? read.text : undefined;
}
