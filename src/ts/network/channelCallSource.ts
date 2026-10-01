// Which job callback is running in this tab, for an aux request made inside it (Phase 5 slice 7a:
// `POST /api/llm/request` carries it as `channelCall`). The job channel's dispatcher is loaded on
// first use (`generationJobs.ts`) and registers its `currentChannelCall` here when it loads; before
// that no callback can be running.
type ChannelCall = { jobId: string; callbackId: string };

let source: (() => ChannelCall | null) | null = null;

export function setChannelCallSource(next: () => ChannelCall | null) {
    source = next;
}

export function activeChannelCall(): ChannelCall | null {
    const call = source?.() ?? null;
    return call ? { jobId: call.jobId, callbackId: call.callbackId } : null;
}
