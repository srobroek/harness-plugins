import { readBoundedBytes } from "@srobroek/opencode-lib/bounded-read";
// The text of a regular, non-symlink file of at most `maxBytes`; anything else is `absent` or `unreadable`.
export function readText(path, maxBytes) {
    const read = readBoundedBytes(path, maxBytes);
    if (read.kind === "bytes")
        return { kind: "text", text: read.bytes.toString("utf8") };
    return { kind: read.kind };
}
