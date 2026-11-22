// Sessions of a lane whose worktree delivery removes. Once the directory is gone a session that
// still points at it fails with "Location not found", so the lane's own sessions are moved home to
// the canonical checkout. Only the lane is touched: its root sessions and their descendants, never
// a project-wide listing. The host still lists and reads such sessions (only booting their location
// fails), so the lane is discovered after the removal and a session created during it is found too.
//
// Failure contract: nothing here fails a cleanup. Every problem (a session that could not be read
// or moved, a listing that was incomplete) comes back as a note for the cleanup result.
import { insideDirectory, isSessionNotFound, laneSessions, moveSessionsHome, } from "@srobroek/opencode-lib/session-lanes";
import { canonicalDirectory } from "@srobroek/opencode-lib/worktree-claims";
const reasonOf = (error) => {
    try {
        const text = error instanceof Error ? error.message : String(error);
        return text === "" ? "read failed" : text;
    }
    catch {
        return "read failed";
    }
};
// The sessions below `roots` (the roots included) whose location is one of `worktrees` (the
// worktree's path in every form it may be recorded in) or inside one. A session that does not
// exist is dropped. Any other read failure leaves it out, makes the answer incomplete and is named
// in `problems`; so does a failed listing, through `complete`.
export async function laneSessionsIn(client, roots, worktrees) {
    const ids = [];
    const problems = [];
    const seen = new Set();
    let complete = true;
    for (const root of roots) {
        const lane = await laneSessions(client, root);
        if (!lane.complete)
            complete = false;
        for (const id of lane.ids) {
            if (seen.has(id))
                continue;
            seen.add(id);
            let session;
            try {
                session = await client.get({ sessionID: id });
            }
            catch (error) {
                if (isSessionNotFound(error, id))
                    continue;
                complete = false;
                problems.push(`session ${id} could not be read: ${reasonOf(error)}`);
                continue;
            }
            const directory = session?.location?.directory;
            if (typeof directory !== "string")
                continue;
            const forms = [directory, canonicalDirectory(directory)];
            if (worktrees.some((worktree) => forms.some((form) => insideDirectory(form, worktree))))
                ids.push(id);
        }
    }
    return { ids, complete, problems };
}
// Move `lane` to `destination`; one note per problem, none when every session moved. A session
// that no longer exists is not a problem.
export async function moveLaneHome(client, lane, destination) {
    const notes = [...lane.problems];
    for (const result of await moveSessionsHome(client, lane.ids, destination)) {
        if (result.status === "error")
            notes.push(`session ${result.id} could not be moved to ${destination}: ${result.reason}`);
    }
    if (!lane.complete)
        notes.push("the lane's sessions were listed incompletely; some may still point at the removed worktree");
    return notes;
}
