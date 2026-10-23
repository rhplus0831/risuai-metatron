import type { CallbackTargets } from "../../../shared/jobs.ts";

// Whether a job callback a plugin call context names (`PluginCallContext.channelCall`) still runs in
// this tab, and on which targets. The job channel's dispatcher is loaded on first use
// (`generationJobs.ts`) and registers its `liveChannelCallTargets` here when it loads; before that no
// callback can be running. Nothing here picks a callback for a request: only a context the
// dispatcher handed to a hook names one.
type ChannelCall = { jobId: string; callbackId: string };

let source: ((call: ChannelCall) => CallbackTargets | null) | null = null;

export function setChannelCallSource(next: (call: ChannelCall) => CallbackTargets | null) {
    source = next;
}

/**
 * What the callback `call` acts on (its job's chat and ids, a `presetChain` pick included) while it
 * runs here and the server has not cancelled it, or null: a request for that chat from inside it runs
 * on these ids.
 */
export function channelCallTargets(call: ChannelCall | undefined): CallbackTargets | null {
    const targets = call ? (source?.(call) ?? null) : null;
    return targets
        ? {
              chatRef: { chaId: targets.chatRef.chaId, chatId: targets.chatRef.chatId },
              presetId: targets.presetId,
              modelPresetId: targets.modelPresetId,
              personaId: targets.personaId,
          }
        : null;
}
