import type { CallbackTargets } from "../../../shared/jobs.ts";

/**
 * Whether a job callback named by `PluginCallContext.channelCall` still runs here, and on which
 * targets. `src/ts/network/generationJobs.ts` loads `src/ts/network/jobChannel.ts` on first use;
 * that dispatcher registers `liveChannelCallTargets` here. Before then no callback can be running.
 * Nothing here selects a callback for a request: only a context handed to a hook names one.
 */

type ChannelCall = { jobId: string; callbackId: string };

let source: ((call: ChannelCall) => CallbackTargets | null) | null = null;

/** Installs the dispatcher's live lookup; captured contexts are checked at use, never cached as live. */
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
