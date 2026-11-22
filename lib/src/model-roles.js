/**
 * The model-roles contract shared by every plugin that ships agents. An agent names its
 * model tier in this request header; the model-roles plugin resolves the tier to a model
 * and strips the header before any request reaches a provider. Without that plugin the
 * header is ignored and the agent keeps its own model, or inherits the session's.
 */
export const MODEL_ROLE_HEADER = "x-opencode-model-role";
/**
 * Request header a plugin sets to the `provider/model#variant` it gave an agent as a
 * fallback. model-roles treats a model equal to this value as replaceable by the
 * agent's tier, and any other model as the user's pin, which it leaves alone.
 */
export const MODEL_FALLBACK_HEADER = "x-opencode-model-fallback";
/** The built-in tiers a shipped agent declares. */
export const MODEL_TIERS = ["cheap", "standard", "strong", "reviewer", "orchestrate"];
/** Old role names model-roles still accepts, and the tier each stands for. `default` means inherit. */
export const MODEL_TIER_ALIASES = {
    default: "inherit",
    smol: "cheap",
    commit: "cheap",
    tiny: "cheap",
    task: "standard",
    slow: "strong",
    plan: "strong",
    architect: "strong",
    designer: "strong",
    challenger: "reviewer",
    judge: "reviewer",
};
/** Every value the header may carry: the tiers, then the accepted aliases (kept literal so bundles can drop it). */
export const MODEL_ROLES = [
    "cheap",
    "standard",
    "strong",
    "reviewer",
    "orchestrate",
    "default",
    "smol",
    "commit",
    "tiny",
    "task",
    "slow",
    "plan",
    "architect",
    "designer",
    "challenger",
    "judge",
];
export function isModelTier(value) {
    return typeof value === "string" && MODEL_TIERS.includes(value);
}
/** A tier or an accepted alias. */
export function isModelRole(value) {
    return typeof value === "string" && MODEL_ROLES.includes(value);
}
/** The tier a header value stands for: the tier itself, an alias's tier, or `undefined`. */
export function tierFor(value) {
    return isModelTier(value) ? value : MODEL_TIER_ALIASES[value];
}
/** The tier an agent's request headers declare, if any. */
export function agentRole(request) {
    return request?.headers?.[MODEL_ROLE_HEADER];
}
