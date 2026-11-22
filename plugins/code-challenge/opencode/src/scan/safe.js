import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
/** Create `segments` below `base` one real directory at a time; a symlink or file in the way is refused. */
export function ensureDir(base, ...segments) {
    let current = base;
    for (const segment of ["", ...segments]) {
        current = segment === "" ? base : join(current, segment);
        try {
            mkdirSync(current, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        if (!lstatSync(current).isDirectory())
            throw new Error(`challenge_scan: refusing to use ${current}: not a real directory`);
    }
    return current;
}
/** Write a private file, replacing a regular file but never following a symlink at `path`. */
export function writeFileNoFollow(path, data) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
        writeSync(fd, data);
    }
    finally {
        closeSync(fd);
    }
}
