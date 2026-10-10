import type { CallbackTargets } from "../../../shared/jobs.ts";

// Which job callback is running in this tab, for an aux request made inside it (Phase 5 slice 7a:
// `POST /api/llm/request` carries it as `channelCall`). The job channel's dispatcher is loaded on
// first use (`generationJobs.ts`) and registers its `currentChannelCall` here when it loads; before
// that no callback can be running.
type ChannelCall = { jobId: string; callbackId: string; targets: CallbackTargets };

let source: (() => ChannelCall | null) | null = null;

export function setChannelCallSource(next: () => ChannelCall | null) {
    source = next;
}

export function activeChannelCall(): { jobId: string; callbackId: string } | null {
    const call = source?.() ?? null;
    return call ? { jobId: call.jobId, callbackId: call.callbackId } : null;
}

/**
 * What the running callback acts on (its job's chat and ids, a `presetChain` pick included), or
 * null: a request for that chat inside it runs on these ids (`docs/plan/chat-binding.md`).
 */
export function activeChannelCallTargets(): CallbackTargets | null {
    const call = source?.() ?? null;
    return call
        ? {
              chatRef: { chaId: call.targets.chatRef.chaId, chatId: call.targets.chatRef.chatId },
              presetId: call.targets.presetId,
              modelPresetId: call.targets.modelPresetId,
              personaId: call.targets.personaId,
          }
        : null;
}
