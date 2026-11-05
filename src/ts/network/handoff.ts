import { get, readonly, writable, type Writable } from "svelte/store";
import type { HandoffOffer } from "../../../shared/events.ts";
import { getResourceEpoch } from "../storage/resourceClient";

/**
 * Device-local worker preferences and epoch-scoped offers. No plugin or follow module loads until
 * an offer needs evaluation. Saved ids prove creation; unsaved offers require /current's owned
 * bit, since a preferred offer can beat the create response. Take a self-targeted offer, an own
 * absent job, or an untargeted foreign job with acceptance enabled; leave own preferred/requested
 * offers alone, as well as offers addressed to another client. Each offer object is evaluated once
 * per acceptance revision, with at most one claim in flight per job. Plugin work stays held from startup
 * through the claim and the lifecycle's own hold, so deferred reloads cannot empty the registries.
 * A successful claim may close its offer before its response arrives: that never cancels its ticket.
 */
function preference<T extends boolean | string>(key: string, fallback: T): Writable<T> {
    const read = (): T => {
        try {
            const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
            return typeof value === typeof fallback ? (value as T) : fallback;
        } catch {
            return fallback;
        }
    };
    const store = writable(read());
    let fromStorage = false;
    store.subscribe((value) => {
        if (fromStorage) return;
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {}
    });
    if (typeof window !== "undefined") {
        window.addEventListener("storage", (event) => {
            if (event.key !== key && event.key !== null) return;
            fromStorage = true;
            try {
                store.set(read());
            } finally {
                fromStorage = false;
            }
        });
    }
    return store;
}

export const acceptHandoffs = preference<boolean>("risu-handoff-accept", false);
export const preferHandoff = preference<boolean>("risu-handoff-prefer", false);
export const clientName = preference<string>("risu-handoff-name", (globalThis.navigator?.userAgent ?? "").slice(0, 64));

const offers = writable<ReadonlyMap<string, HandoffOffer>>(new Map());
export const handoffOffers = readonly(offers);
const claiming = new Set<string>();
const evaluated = new WeakMap<HandoffOffer, number>();
let acceptanceRevision = 0;

export type HandoffWork = { jobId: string; characterName: string; phase: "pending" | "working" };
const work = writable<ReadonlyMap<string, HandoffWork>>(new Map());
export const handoffWork = readonly(work);

/** Non-modal per-job status, independent of the alert/dialog slots. Null clears only this job. */
export function setHandoffWork(jobId: string, status: Omit<HandoffWork, "jobId"> | null): void {
    work.update((current) => {
        const next = new Map(current);
        if (status) next.set(jobId, { jobId, ...status });
        else next.delete(jobId);
        return next;
    });
}

/** A hello replaces the whole open set; an older server's missing snapshot is empty. */
export function replaceHandoffOffers(snapshot: readonly HandoffOffer[]): void {
    offers.set(
        new Map(
            snapshot
                .filter((offer) => offer.state === "open" && offer.epoch === getResourceEpoch())
                .map((offer) => [offer.jobId, offer]),
        ),
    );
    evaluateOffers();
}

/** Wrong-epoch and unknown feed frames never alter the loaded epoch's offers. */
export function receiveHandoffOffer(offer: HandoffOffer): void {
    if (offer.epoch !== getResourceEpoch()) return;
    offers.update((current) => {
        const next = new Map(current);
        if (offer.state === "open") next.set(offer.jobId, offer);
        else if (offer.state === "closed") next.delete(offer.jobId);
        return next;
    });
    evaluateOffers();
}

function dropOffer(offer: HandoffOffer) {
    if (get(offers).get(offer.jobId) !== offer) return;
    offers.update((current) => {
        const next = new Map(current);
        next.delete(offer.jobId);
        return next;
    });
}

function evaluateOffers() {
    for (const offer of get(offers).values()) {
        if (claiming.has(offer.jobId) || evaluated.get(offer) === acceptanceRevision) continue;
        claiming.add(offer.jobId);
        const revision = acceptanceRevision;
        evaluated.set(offer, revision);
        void takeOffer(offer)
            .catch((error) => console.warn("[Handoff]", error))
            .finally(() => {
                claiming.delete(offer.jobId);
                // New offers or an opt-in while a rejected evaluation unwinds must be reconsidered.
                const next = get(offers).get(offer.jobId);
                if (next && (next !== offer || revision !== acceptanceRevision)) evaluateOffers();
            });
    }
}

async function takeOffer(offer: HandoffOffer): Promise<void> {
    const jobs = await import("./generationJobs");
    const self = jobs.generationClientId();
    if (offer.target && offer.target !== self) return;
    if (offer.target !== self && offer.reason !== "absent" && !get(acceptHandoffs)) return;
    let own = jobs.savedGenerationJobIds().includes(offer.jobId);
    if (!own) {
        const current = await jobs.readChatGeneration({ chaId: offer.characterId, chatId: offer.chatId });
        if (!current || current.jobId !== offer.jobId) {
            dropOffer(offer);
            return;
        }
        own = current.owned;
    }
    const allowed = () =>
        offer.target === self || (own && offer.reason === "absent") || (!own && !offer.target && get(acceptHandoffs));
    const current = () => offer.epoch === getResourceEpoch() && get(offers).get(offer.jobId) === offer;
    if (!current() || !allowed()) return;
    const release = jobs.holdGenerationPluginWork();
    try {
        const { pluginsStarted } = await import("../plugins/plugins.svelte");
        await pluginsStarted();
        // Load the lifecycle before claiming: the short-lived ticket must reach an attach promptly.
        const { followJobToEnd } = await import("../process/serverCommands");
        if (!current() || !allowed()) return;
        const ticket = await jobs.takeoverGenerationJob(offer.jobId);
        if (!ticket) {
            dropOffer(offer);
            return;
        }
        if (offer.epoch !== getResourceEpoch()) return;
        // This call synchronously takes its own plugin hold until its first socket follow starts.
        void followJobToEnd(offer.jobId, { chaId: offer.characterId, chatId: offer.chatId }, undefined, {
            ticket,
        }).catch((error) => console.error("[Handoff]", error));
    } finally {
        release();
    }
}

acceptHandoffs.subscribe((enabled) => {
    if (enabled) {
        acceptanceRevision++;
        evaluateOffers();
    }
});
