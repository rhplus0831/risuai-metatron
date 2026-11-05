import { get, readonly, writable, type Writable } from "svelte/store";
import {
    MAX_FEED_CLIENT_NAME,
    MAX_FEED_CLIENTS,
    type EventFeedClientMessage,
    type FeedClient,
    type HandoffOffer,
} from "../../../shared/events.ts";
import { language } from "src/lang";
import { getResourceEpoch, ResourceRequestError } from "../storage/resourceClient";

/**
 * Device-local worker preferences, connected clients and epoch-scoped offers. No plugin or follow module loads until
 * an offer needs evaluation. Saved ids prove creation; unsaved offers require /current's owned
 * bit, since a preferred offer can beat the create response. Take a self-targeted offer, an own
 * absent job, or an untargeted foreign job with acceptance enabled; leave own preferred/requested
 * offers alone, as well as offers addressed to another client. Each offer object is evaluated once
 * per acceptance revision, except transient /current or claim failures get bounded retries with exponential
 * backoff while that object, epoch and revision remain current. At most one claim is in flight per job.
 * Plugin work stays held from startup through the claim and the lifecycle's own hold, so deferred reloads
 * cannot empty the registries.
 * A successful claim may close its offer before its response arrives: that never cancels its ticket.
 * Manual requests use the same acceptance policy, with one best-effort reminder per job after 10 s
 * if that epoch's requested offer is still open for the same target. This does not track completion.
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
export const clientName = preference<string>(
    "risu-handoff-name",
    (globalThis.navigator?.userAgent ?? "").slice(0, MAX_FEED_CLIENT_NAME),
);

const clients = writable<readonly FeedClient[]>([]);
export const connectedClients = readonly(clients);

/** Presence snapshots replace the whole list; malformed entries are ignored. */
export function replaceConnectedClients(snapshot: unknown): void {
    const next: FeedClient[] = [];
    const seen = new Set<string>();
    if (Array.isArray(snapshot)) {
        for (const client of snapshot) {
            if (
                typeof client !== "object" ||
                client === null ||
                typeof client.clientId !== "string" ||
                !client.clientId ||
                typeof client.name !== "string" ||
                typeof client.worker !== "boolean" ||
                seen.has(client.clientId)
            )
                continue;
            seen.add(client.clientId);
            next.push({
                clientId: client.clientId,
                name: client.name.slice(0, MAX_FEED_CLIENT_NAME),
                worker: client.worker,
            });
            if (next.length === MAX_FEED_CLIENTS) break;
        }
    }
    clients.set(next);
}

/** Each name targets its first worker in list order (the server lists newest registrations first). */
export function handoffTargets(clients: readonly FeedClient[], selfId: string) {
    const groups = new Map<string, { name: string; clientId: string; count: number }>();
    for (const client of clients) {
        if (!client.worker || client.clientId === selfId) continue;
        const group = groups.get(client.name);
        if (group) group.count++;
        else groups.set(client.name, { name: client.name, clientId: client.clientId, count: 1 });
    }
    return [...groups.values()];
}

export function registration(selfId: string): EventFeedClientMessage {
    return {
        type: "register",
        clientId: selfId,
        name: get(clientName).slice(0, MAX_FEED_CLIENT_NAME),
        worker: get(acceptHandoffs),
    };
}

export const HANDOFF_REMINDER_MS = 10_000;
const reminders = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();

/** A new request replaces the job's reminder, even if an earlier request is still awaiting its answer. */
export async function handOffJob(jobId: string, target: string): Promise<void> {
    clearTimeout(reminders.get(jobId)?.timer);
    const reminder: { timer?: ReturnType<typeof setTimeout> } = {};
    reminders.set(jobId, reminder);
    const epoch = getResourceEpoch();
    const { alertToast } = await import("../alert");
    try {
        const { requestGenerationHandoff } = await import("./generationJobs");
        if ((await requestGenerationHandoff(jobId, target)) === "unavailable") {
            alertToast(language.serverJob.handoff.unavailable);
            return;
        }
        if (reminders.get(jobId) !== reminder || getResourceEpoch() !== epoch) return;
        reminder.timer = setTimeout(() => {
            if (reminders.get(jobId) !== reminder) return;
            reminders.delete(jobId);
            const offer = get(offers).get(jobId);
            if (
                getResourceEpoch() === epoch &&
                offer?.epoch === epoch &&
                offer.state === "open" &&
                offer.reason === "requested" &&
                offer.target === target
            )
                alertToast(language.serverJob.handoff.notTaken);
        }, HANDOFF_REMINDER_MS);
    } catch (error) {
        alertToast(
            language.serverJob.handoff.requestFailed.replace("{error}", () =>
                error instanceof Error ? error.message : String(error),
            ),
        );
    } finally {
        if (!reminder.timer && reminders.get(jobId) === reminder) reminders.delete(jobId);
    }
}

const offers = writable<ReadonlyMap<string, HandoffOffer>>(new Map());
export const handoffOffers = readonly(offers);
const claiming = new Set<string>();
const evaluated = new WeakMap<HandoffOffer, number>();
const retryAttempts = new WeakMap<HandoffOffer, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const HANDOFF_RETRY_MS = 1_000;
const HANDOFF_RETRY_MAX_MS = 30_000;
const HANDOFF_MAX_RETRIES = 5;
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
    const next = new Map(
        snapshot
            .filter((offer) => offer.state === "open" && offer.epoch === getResourceEpoch())
            .map((offer) => [offer.jobId, offer]),
    );
    for (const [jobId, offer] of get(offers)) {
        if (next.get(jobId) !== offer) clearRetry(jobId);
    }
    offers.set(next);
    evaluateOffers();
}

/** Wrong-epoch and unknown feed frames never alter the loaded epoch's offers. */
export function receiveHandoffOffer(offer: HandoffOffer): void {
    if (offer.epoch !== getResourceEpoch()) return;
    offers.update((current) => {
        const next = new Map(current);
        if (offer.state === "open") {
            if (current.get(offer.jobId) !== offer) clearRetry(offer.jobId);
            next.set(offer.jobId, offer);
        } else if (offer.state === "closed") {
            clearRetry(offer.jobId);
            next.delete(offer.jobId);
        }
        return next;
    });
    evaluateOffers();
}

function dropOffer(offer: HandoffOffer) {
    if (get(offers).get(offer.jobId) !== offer) return;
    clearRetry(offer.jobId);
    offers.update((current) => {
        const next = new Map(current);
        next.delete(offer.jobId);
        return next;
    });
}

function clearRetry(jobId: string) {
    clearTimeout(retryTimers.get(jobId));
    retryTimers.delete(jobId);
}

function retryOffer(offer: HandoffOffer, revision: number) {
    const current = () =>
        get(offers).get(offer.jobId) === offer && offer.epoch === getResourceEpoch() && revision === acceptanceRevision;
    const attempts = retryAttempts.get(offer) ?? 0;
    if (!current() || attempts >= HANDOFF_MAX_RETRIES || retryTimers.has(offer.jobId)) return;
    const timer = setTimeout(
        () => {
            if (retryTimers.get(offer.jobId) !== timer) return;
            retryTimers.delete(offer.jobId);
            if (!current()) return;
            retryAttempts.set(offer, attempts + 1);
            evaluated.delete(offer);
            evaluateOffers();
        },
        Math.min(HANDOFF_RETRY_MS * 2 ** attempts, HANDOFF_RETRY_MAX_MS),
    );
    retryTimers.set(offer.jobId, timer);
}

function evaluateOffers() {
    for (const offer of get(offers).values()) {
        if (claiming.has(offer.jobId) || evaluated.get(offer) === acceptanceRevision) continue;
        clearRetry(offer.jobId);
        claiming.add(offer.jobId);
        const revision = acceptanceRevision;
        evaluated.set(offer, revision);
        void takeOffer(offer, revision)
            .catch((error) => console.warn("[Handoff]", error))
            .finally(() => {
                claiming.delete(offer.jobId);
                // New offers or an opt-in while a rejected evaluation unwinds must be reconsidered.
                const next = get(offers).get(offer.jobId);
                if (next && (next !== offer || revision !== acceptanceRevision)) evaluateOffers();
            });
    }
}

async function takeOffer(offer: HandoffOffer, revision: number): Promise<void> {
    const failedRequest = (error: unknown): never => {
        if (error instanceof ResourceRequestError && (error.status === 0 || error.status >= 500))
            retryOffer(offer, revision);
        throw error;
    };
    const jobs = await import("./generationJobs");
    const self = jobs.generationClientId();
    if (offer.target && offer.target !== self) return;
    if (offer.target !== self && offer.reason !== "absent" && !get(acceptHandoffs)) return;
    let own = jobs.savedGenerationJobIds().includes(offer.jobId);
    if (!own) {
        const current = await jobs
            .readChatGeneration({ chaId: offer.characterId, chatId: offer.chatId })
            .catch(failedRequest);
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
        const ticket = await jobs.takeoverGenerationJob(offer.jobId).catch(failedRequest);
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
