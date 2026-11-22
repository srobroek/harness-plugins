/**
 * The TUI side of the announcements, apart from the host: it toasts each new finding once per
 * instance, counts the unseen ones for the badge, and marks findings seen. `tui.tsx` only wires
 * it to the RPC, the toast and a signal.
 */
import { readFindings, toastKey, toastText, unseen } from "./announce.ts";
export function createAnnouncements(ports, onChange = () => { }) {
    /** Toasted by this instance; a toast marks a finding toasted, never seen. */
    const toasted = new Set();
    let findings = [];
    const set = (next) => {
        findings = next;
        onChange(unseen(findings).length);
    };
    return {
        /** Fetches the unseen findings and shows one toast per finding not toasted yet. A failed fetch keeps what is shown. */
        async refresh() {
            let next;
            try {
                next = unseen(readFindings(await ports.fetch()));
            }
            catch {
                return;
            }
            set(next);
            for (const f of next) {
                const key = toastKey(f);
                if (toasted.has(key))
                    continue;
                toasted.add(key);
                ports.toast(toastText(f));
            }
        },
        /** Opening a tier's detail, a dismissal or an adoption: the tier's (or one agent's) findings are seen. */
        async markSeen(tier, agent) {
            const mine = findings.filter((f) => f.tier === tier && (agent === undefined || f.agent === agent));
            if (mine.length === 0)
                return;
            set(findings.filter((f) => !mine.includes(f)));
            for (const f of mine)
                await ports.seen(f.tier, f.agent).catch(() => { });
        },
        /** Unseen findings of one tier. */
        forTier: (tier) => findings.filter((f) => f.tier === tier),
        count: () => findings.length,
    };
}
export const DISMISS_PREFIX = "\u0000dismiss:";
/** One "Dismiss" row per agent with an unseen finding in the tier. */
export const dismissRows = (agents) => agents.map((agent) => ({ title: `Dismiss announcement (${agent})`, value: `${DISMISS_PREFIX}${agent}`, description: "Clear it from the tiers badge" }));
