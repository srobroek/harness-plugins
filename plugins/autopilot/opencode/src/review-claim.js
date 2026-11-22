/**
 * The once-only claim on a review. A head is reviewed by the plugin at most once, however the
 * review ends, so a verdict cannot be re-rolled by voiding or deleting a reviewer. Claims are files
 * in `<autopilot root>/review-claims/`, next to the run directories, so they outlive a run. Each is
 * created the way run state generations are: the content goes to a temporary file that is
 * hard-linked to the claim name, and `link` fails with EEXIST when the name is taken, atomically.
 * A claim is released only when the start it guarded was refused before any reviewer existed.
 */
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const CLAIM_DIR = "review-claims";
/** The claim names for one start: one per PR and head, and one per head alone. */
export const claimNames = (pr, sha) => [`pr-${pr}@${sha}`, `head-${sha}`];
/** Take every claim in `names`, or none: a claim taken before a collision is released again. */
export function takeClaims(root, names, owner) {
    const dir = join(root, CLAIM_DIR);
    const held = [];
    try {
        mkdirSync(dir, { recursive: true });
        for (const name of names) {
            const temporary = join(dir, `.tmp-${randomUUID()}`);
            writeFileSync(temporary, JSON.stringify({ owner, at: Date.now() }), { flag: "wx" });
            try {
                linkSync(temporary, join(dir, name));
                held.push(name);
            }
            catch (error) {
                if (error.code === "EEXIST") {
                    releaseClaims(root, held);
                    return { ok: false, taken: name };
                }
                throw error;
            }
            finally {
                rmSync(temporary, { force: true });
            }
        }
        return { ok: true };
    }
    catch (error) {
        releaseClaims(root, held);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/** Remove claims; throws when one cannot be removed, so the caller can journal it. */
export function releaseClaims(root, names) {
    for (const name of names)
        rmSync(join(root, CLAIM_DIR, name), { force: true });
}
