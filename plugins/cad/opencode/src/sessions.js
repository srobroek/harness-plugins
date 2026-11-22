const key = (host) => `${host.cwd}\0${host.session}`;
/**
 * What `cad_run` left running, by root session: background scripts and viewer hosts. Each is
 * stopped when its session is deleted, and everything when the plugin is disposed.
 */
export class CadSessions {
    owned = new Map();
    entry(root) {
        let owned = this.owned.get(root);
        if (owned === undefined) {
            owned = { jobs: new Map(), viewers: new Map() };
            this.owned.set(root, owned);
        }
        return owned;
    }
    addJob(root, job) {
        this.entry(root).jobs.set(job.pid, job);
    }
    /** Remove and return the session's job with this pid, if it has one. */
    takeJob(root, pid) {
        const job = this.owned.get(root)?.jobs.get(pid);
        if (job !== undefined)
            this.owned.get(root)?.jobs.delete(pid);
        return job;
    }
    /** Forget a job that exited on its own; a newer job that reused its pid stays. */
    removeJob(root, job) {
        const jobs = this.owned.get(root)?.jobs;
        if (jobs?.get(job.pid) === job)
            jobs.delete(job.pid);
    }
    addViewer(root, host) {
        this.entry(root).viewers.set(key(host), host);
    }
    removeViewer(root, host) {
        this.owned.get(root)?.viewers.delete(key(host));
    }
    /** Remove and return everything the session owns. */
    take(root) {
        const owned = this.owned.get(root);
        this.owned.delete(root);
        return { jobs: [...(owned?.jobs.values() ?? [])], viewers: [...(owned?.viewers.values() ?? [])] };
    }
    roots() {
        return [...this.owned.keys()];
    }
}
