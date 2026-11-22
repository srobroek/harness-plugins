/** The optional `worktree` parameter that subagent-worktree adds to the `subagent` tool, and that model-roles must keep when it adds its own. */
export const WORKTREE_PARAM = "worktree";
export const WORKTREE_PARAM_DESCRIPTION = "New spawns only. Omit for defaults: opted-in writers get a fresh lane; others start in your directory. Path or branch starts in another existing worktree; false keeps an opted-in writer in your directory.";
