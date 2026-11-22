/** The server answers `unknown round <id>` for a round it does not hold, as after a plugin reload that lost it. */
export const isUnknownRound = (errors) => errors.some((error) => /unknown round/i.test(error));
/** The server answers `undelivered round <id>: <error>` for a closed round whose message to the agent kept failing. */
export const isUndeliveredRound = (errors) => errors.some((error) => /undelivered round/i.test(error));
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
/**
 * Submits a round's answers. When they cannot reach the agent through the round (the server lost the
 * round, or its message kept failing), the user is never stranded: the error shows once, then they pick
 * between sending the answers as a message and dismissing the card. Returns the problems to show on the
 * card (none when the card is done).
 */
export async function submitRound(flow) {
    const outcome = await flow.submit().catch((error) => ({ ok: false, errors: [messageOf(error)] }));
    if (outcome.ok) {
        // Errors on success: the round took the answers but the first message to the agent failed. The server
        // retries it, and brings the card back if it keeps failing.
        if (outcome.errors?.length)
            flow.notify(outcome.errors.join(" "), "warning");
        else
            flow.notify("Answers sent", "success");
        await flow.settle();
        return [];
    }
    const errors = [...(outcome.errors ?? ["Submit failed"])];
    if (isUnknownRound(errors))
        flow.notify("This round is gone from the server (the plugin probably reloaded).", "warning");
    else if (isUndeliveredRound(errors))
        flow.notify(errors.join(" "), "warning");
    else
        return errors;
    if (!(await flow.choose())) {
        await flow.dismiss();
        await flow.settle();
        return [];
    }
    const sent = await flow.deliver().catch((error) => ({ ok: false, errors: [messageOf(error)] }));
    if (!sent.ok)
        return [...(sent.errors ?? ["Could not send the answers as a message"])];
    flow.notify("Answers sent as a message", "success");
    await flow.settle();
    return [];
}
