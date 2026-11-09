import { get, writable } from "svelte/store";
import {
    isCompletionNotificationTag,
    NOTIFICATION_ICON,
    parseChatRoutePath,
    PUSH_KEY_PATH,
    PUSH_REGISTRATION_REFRESH_MS,
    PUSH_SUBSCRIPTION_PATH,
} from "../../../shared/notifications.ts";
import { language } from "../../lang";
import { recordClientEvent } from "../diagnostics/collector";
import { openRoute } from "../router/router.svelte";
import { authFetch } from "../storage/serverAuth";
import { settings } from "../storage/settingsViews.svelte";

/**
 * This browser's Web Push. `settings.ui.notification` (synced) decides
 * whether the server sends; this browser receives when it holds a subscription the server knows.
 *
 * - The permission is requested only from a click (`enablePushOnThisBrowser`): the one-time banner
 *   (`PushPrompt.svelte`) or the Notification setting. Nothing here asks on its own.
 * - With the permission already granted, `reconcilePush` keeps the subscription registered (push
 *   services rotate them, and a server key change needs a new one) unless this browser opted out.
 * - The banner is shown once per browser: either of its buttons dismisses it for good.
 * - Enable, disable, and sync serialize across tabs under the `risu-push` Web Lock when available,
 *   otherwise on this tab's promise chain. Enable requests permission synchronously before either.
 */

/** Browser/server eligibility, independent of permission, subscription and this browser's opt-out. */
export type PushAvailability =
    /** Not checked yet. */
    | "checking"
    | "ok"
    /** Push needs HTTPS or `localhost`. */
    | "insecure"
    /** iOS delivers push only to a Home Screen web app. */
    | "ios-home-screen"
    | "unsupported"
    /** The server has no VAPID key (`/api/push/key` answered null). */
    | "server-off";

/** This page's observed push state; the synced notification setting and browser opt-out are separate. */
export type PushBrowserState = {
    availability: PushAvailability;
    permission: NotificationPermission | "unsupported";
    /** This browser's current subscription was registered within the refresh interval. */
    subscribed: boolean;
    /** This browser was turned off in the settings: no automatic subscription. */
    optedOut: boolean;
    /** The one-time banner was answered. */
    promptDismissed: boolean;
    /** An enable or disable is running. */
    busy: boolean;
    /** The last enable, disable, or sync failure (localized), shown in the settings until a sync clears it. */
    error: string | null;
};

const PROMPT_DISMISSED_KEY = "risu-push-prompt-dismissed";
const OPTED_OUT_KEY = "risu-push-browser-off";
/** An endpoint whose server removal failed, removed again on the next sync. */
const PENDING_REMOVAL_KEY = "risu-push-pending-removal";
/** Set when the browser kept its subscription at a disable: unsubscribed again on the next sync. */
const PENDING_UNSUBSCRIBE_KEY = "risu-push-pending-unsubscribe";
const REGISTERED_KEY = "risu-push-registered";
const REGISTRATION_TIMEOUT_MS = 10_000;

type RegistrationStamp = {
    endpoint: string;
    p256dh: string;
    auth: string;
    serverKey: string;
    at: number;
};

/** Registration evidence is read fresh inside the push lock; it never uses the per-tab flag overrides. */
function readRegistrationStamp(): RegistrationStamp | null {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(REGISTERED_KEY) ?? "null");
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const stamp = value as Partial<RegistrationStamp>;
        if (
            typeof stamp.endpoint !== "string" ||
            !stamp.endpoint ||
            typeof stamp.p256dh !== "string" ||
            !stamp.p256dh ||
            typeof stamp.auth !== "string" ||
            !stamp.auth ||
            typeof stamp.serverKey !== "string" ||
            !stamp.serverKey ||
            typeof stamp.at !== "number" ||
            !Number.isFinite(stamp.at)
        ) {
            return null;
        }
        return stamp as RegistrationStamp;
    } catch {
        return null;
    }
}

/** Called only inside the push lock. A failed storage write leaves no in-memory evidence to reuse. */
function writeRegistrationStamp(stamp: RegistrationStamp | null) {
    try {
        if (stamp === null) {
            localStorage.removeItem(REGISTERED_KEY);
        } else {
            localStorage.setItem(REGISTERED_KEY, JSON.stringify(stamp));
        }
    } catch {}
}

/**
 * A flag whose storage write failed (blocked storage, a full quota) is kept here for this page and
 * wins over storage until a later write of it succeeds. Otherwise a readable storage is the truth,
 * also when another tab removed a flag.
 */
const unsaved = new Map<string, string | null>();
/** The last value read or written, for a read that throws later. */
const lastKnown = new Map<string, string | null>();

function readStored(key: string): string | null {
    if (unsaved.has(key)) {
        return unsaved.get(key) ?? null;
    }
    try {
        const value = localStorage.getItem(key);
        lastKnown.set(key, value);
        return value;
    } catch {
        return lastKnown.get(key) ?? null;
    }
}

function writeStored(key: string, value: string | null) {
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
        unsaved.delete(key);
    } catch {
        unsaved.set(key, value);
    }
    lastKnown.set(key, value);
}

function currentPermission(): NotificationPermission | "unsupported" {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function isIos(): boolean {
    return (
        /iP(hone|ad|od)/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
}

function isStandalone(): boolean {
    return (
        window.matchMedia?.("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
}

/** What this browser itself allows, before asking the server. */
function browserAvailability(): PushAvailability {
    if (!window.isSecureContext) {
        return "insecure";
    }
    if (isIos() && !isStandalone()) {
        return "ios-home-screen";
    }
    if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        return "unsupported";
    }
    return "ok";
}

/** Observable push controls and failures; registration evidence remains in storage under the push lock. */
export const pushBrowserState = writable<PushBrowserState>({
    availability: "checking",
    permission: "default",
    subscribed: false,
    optedOut: false,
    promptDismissed: false,
    busy: false,
    error: null,
});

function update(patch: Partial<PushBrowserState>) {
    pushBrowserState.update((state) => ({ ...state, ...patch }));
}

let started = false;
let serverKey: string | null = null;
/** Set by the boot's key read and taken by the first sync, so a boot reads the key once. */
let keyJustRead = false;
/** Enable, disable, and sync run one at a time, across tabs when Web Locks are available. */
let queue: Promise<unknown> = Promise.resolve();
/** The last contiguous reconciliation, only while it is waiting for the queue or Web Lock. */
let queuedReconcile: Promise<void> | null = null;

function serial<T>(task: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => (navigator.locks ? navigator.locks.request("risu-push", task) : task());
    const run = queue.then(locked, locked);
    queue = run.catch(() => {});
    return run;
}

function decodeKey(key: string): Uint8Array<ArrayBuffer> {
    const base64 = key.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function sameKey(subscription: PushSubscription, key: string): boolean {
    const current = subscription.options?.applicationServerKey;
    if (!current) {
        return false;
    }
    const a = new Uint8Array(current);
    const b = decodeKey(key);
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A key read; `failure` is set when the read failed and `key` is the last key read before. */
type KeyRead = { key: string | null; failure?: unknown };

/**
 * Reads the server's VAPID key: null (and `server-off`) when push is off there. Each sync reads it
 * again, so an open tab follows a key change, or push turned on or off on the server. A failed read
 * answers the last key read with the failure, and throws when there is none.
 */
async function loadServerKey(): Promise<KeyRead> {
    try {
        const response = await authFetch(PUSH_KEY_PATH);
        if (!response.ok) {
            throw new Error(language.pushNotifications.keyRequestFailed(response.status));
        }
        const body = (await response.json()) as { publicKey?: unknown };
        serverKey = typeof body.publicKey === "string" && body.publicKey ? body.publicKey : null;
    } catch (error) {
        if (serverKey) {
            return { key: serverKey, failure: error };
        }
        throw error;
    }
    update({ availability: serverKey ? "ok" : "server-off" });
    return { key: serverKey };
}

/** The active service worker registration, or null when there is none within the timeout. */
async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (!("serviceWorker" in navigator)) {
        return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), REGISTRATION_TIMEOUT_MS);
    });
    try {
        return await Promise.race([navigator.serviceWorker.ready, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function removeOnServer(endpoint: string): Promise<void> {
    const response = await authFetch(PUSH_SUBSCRIPTION_PATH, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
    });
    if (!response.ok) {
        throw new Error(language.pushNotifications.removalFailed(response.status));
    }
    if (readRegistrationStamp()?.endpoint === endpoint) {
        writeRegistrationStamp(null);
    }
}

/** Retries a removal that failed before (a disable while the server was away). */
async function flushPendingRemoval() {
    const endpoint = readStored(PENDING_REMOVAL_KEY);
    if (!endpoint) {
        return;
    }
    try {
        await removeOnServer(endpoint);
        writeStored(PENDING_REMOVAL_KEY, null);
    } catch {}
}

/** `unsubscribe()` either rejects or resolves `false` when the browser keeps the subscription. */
function unsubscribed(subscription: PushSubscription): Promise<boolean> {
    return subscription.unsubscribe().then(
        (done) => done !== false,
        () => false,
    );
}

/**
 * Retries a browser unsubscribe that failed at a disable. Dropped once this browser is turned on again
 * (here or in another tab), so the wanted subscription is kept.
 */
async function flushPendingUnsubscribe(optedOut: boolean) {
    if (!readStored(PENDING_UNSUBSCRIBE_KEY)) {
        return;
    }
    if (!optedOut) {
        writeStored(PENDING_UNSUBSCRIBE_KEY, null);
        return;
    }
    try {
        const registration = await readyRegistration();
        if (!registration) {
            return;
        }
        const subscription = await registration.pushManager.getSubscription();
        // Read again after the waits: another tab may have turned this browser on meanwhile.
        if (readStored(OPTED_OUT_KEY) !== "1" || !readStored(PENDING_UNSUBSCRIBE_KEY)) {
            return;
        }
        if (subscription) {
            writeRegistrationStamp(null);
            if (!(await unsubscribed(subscription))) {
                update({ error: language.pushNotifications.unsubscribeFailed });
                return;
            }
        }
        writeStored(PENDING_UNSUBSCRIBE_KEY, null);
    } catch {}
}

/**
 * Registers this browser's subscription with the server, creating it (or replacing one made for an
 * old server key) first. Needs the permission granted; creating a subscription may need a click on
 * some browsers, so a failure here is reported, not fatal. `known` is a key this sync already read.
 * `risu-push-registered` is evidence `{ endpoint, p256dh, auth, serverKey, at }`: an identical
 * registration skips PUT for `PUSH_REGISTRATION_REFRESH_MS` (24 h), while changed identity/key,
 * invalid evidence, or explicit enable (`force`) registers again. Evidence is read/written only
 * inside the push lock. A successful PUT stamps a complete identity; failed PUT, disable,
 * unsubscribe, or successful removal of its endpoint clears it. Storage failure leaves no reusable
 * in-memory evidence.
 * A new subscription is undone before registration if another tab opted out while it was being created.
 */
async function ensureSubscribed(force: boolean, known: KeyRead | null = null): Promise<void> {
    const { key, failure } = known ?? (await loadServerKey());
    if (!key) {
        update({ subscribed: false });
        return;
    }
    const registration = await readyRegistration();
    if (!registration) {
        throw new Error(language.pushNotifications.noServiceWorker);
    }
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, key)) {
        if (failure !== undefined) {
            // Another tab may have subscribed for a newer key: replace nothing until the key is read.
            throw failure;
        }
        writeRegistrationStamp(null);
        const stale = subscription.endpoint;
        const removed = await unsubscribed(subscription);
        await removeOnServer(stale).catch(() => writeStored(PENDING_REMOVAL_KEY, stale));
        if (!removed) {
            // The browser refuses a new key while it holds the old subscription; the next sync retries.
            throw new Error(language.pushNotifications.unsubscribeFailed);
        }
        subscription = null;
    }
    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeKey(key),
        });
        if (readStored(OPTED_OUT_KEY) === "1") {
            const removed = await unsubscribed(subscription);
            writeStored(PENDING_UNSUBSCRIBE_KEY, removed ? null : "1");
            update({
                subscribed: false,
                optedOut: true,
                error: removed ? null : language.pushNotifications.unsubscribeFailed,
            });
            return;
        }
    }
    const serialized = subscription.toJSON();
    const endpoint = serialized.endpoint;
    const p256dh = serialized.keys?.p256dh;
    const auth = serialized.keys?.auth;
    const identity = endpoint && p256dh && auth ? { endpoint, p256dh, auth, serverKey: key } : null;
    const stamp = readRegistrationStamp();
    const age = stamp ? Date.now() - stamp.at : -1;
    if (
        !force &&
        identity &&
        stamp &&
        stamp.endpoint === identity.endpoint &&
        stamp.p256dh === identity.p256dh &&
        stamp.auth === identity.auth &&
        stamp.serverKey === identity.serverKey &&
        age >= 0 &&
        age < PUSH_REGISTRATION_REFRESH_MS
    ) {
        update({ subscribed: true, error: null });
        return;
    }
    try {
        const response = await authFetch(PUSH_SUBSCRIPTION_PATH, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subscription: serialized }),
        });
        if (!response.ok) {
            throw new Error(language.pushNotifications.registrationRefused(response.status));
        }
        writeRegistrationStamp(identity ? { ...identity, at: Date.now() } : null);
    } catch (error) {
        writeRegistrationStamp(null);
        throw error;
    }
    update({ subscribed: true, error: null });
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Brings this browser in line with the settings without asking anything: registers the subscription
 * while the switch is on, the permission granted, and this browser not opted out. Safe to call often
 * (boot, the switch turned on elsewhere, the page shown again).
 * Eligible registration syncs read `/api/push/key` again (boot supplies its first read); server-off
 * gets a best-effort probe too. Opt-out, permission, settings and availability gates can skip
 * registration. During registration, a failed key read can use the last key, but never replaces a
 * subscription made for another key; that mismatch, or no cached key, reports the read's error.
 * Waiting reconciliations share one promise until their task starts, including the Web Lock wait.
 * A running task permits one further queued run; enable/disable breaks this fold to preserve order.
 */
export function reconcilePush(): Promise<void> {
    if (!started) {
        return Promise.resolve();
    }
    if (queuedReconcile) {
        return queuedReconcile;
    }
    const releaseFold = () => {
        if (queuedReconcile === run) {
            queuedReconcile = null;
        }
    };
    const run: Promise<void> = serial(async () => {
        releaseFold();
        let known: KeyRead | null = keyJustRead ? { key: serverKey } : null;
        keyJustRead = false;
        const permission = currentPermission();
        let optedOut = readStored(OPTED_OUT_KEY) === "1";
        update({ permission, optedOut, promptDismissed: readStored(PROMPT_DISMISSED_KEY) === "1" });
        if (!known && get(pushBrowserState).availability === "server-off") {
            // Push may have been turned on on the server since.
            try {
                known = await loadServerKey();
            } catch {}
        }
        if (get(pushBrowserState).availability !== "ok") {
            return;
        }
        await flushPendingRemoval();
        await flushPendingUnsubscribe(optedOut);
        // Read again: another tab may have turned this browser on while the retried unsubscribe ran, and
        // the subscription it registered is then made again below.
        optedOut = readStored(OPTED_OUT_KEY) === "1";
        update({ optedOut });
        if (optedOut || permission !== "granted") {
            // Here only an unsubscribe still pending is a failure left to show.
            update({ subscribed: false, ...(readStored(PENDING_UNSUBSCRIBE_KEY) ? {} : { error: null }) });
            return;
        }
        if (!settings.ui.notification) {
            update({ error: null });
            return;
        }
        try {
            await ensureSubscribed(false, known);
        } catch (error) {
            update({ subscribed: false, error: describe(error) });
        }
    });
    queuedReconcile = run;
    // Also release a lock request that failed before the task could start.
    void run.then(releaseFold, releaseFold);
    return run;
}

/**
 * Turns push on for this browser. Call it straight from a click handler: the permission request is
 * the first thing it does, before any wait, or browsers refuse it. Resolves to whether this browser
 * is now subscribed.
 */
export function enablePushOnThisBrowser(): Promise<boolean> {
    writeStored(PROMPT_DISMISSED_KEY, "1");
    if (typeof Notification === "undefined") {
        update({ promptDismissed: true });
        return Promise.resolve(false);
    }
    // Synchronously, inside the click.
    const permission =
        Notification.permission === "default"
            ? Notification.requestPermission()
            : Promise.resolve(Notification.permission);
    queuedReconcile = null;
    return serial(async () => {
        update({ busy: true, promptDismissed: true, error: null });
        try {
            const result = await permission;
            update({ permission: result });
            if (result !== "granted") {
                return false;
            }
            writeStored(OPTED_OUT_KEY, null);
            writeStored(PENDING_UNSUBSCRIBE_KEY, null);
            update({ optedOut: false });
            if (get(pushBrowserState).availability !== "ok") {
                return false;
            }
            await ensureSubscribed(true);
            return get(pushBrowserState).subscribed;
        } catch (error) {
            update({ subscribed: false, error: describe(error) });
            return false;
        } finally {
            update({ busy: false });
        }
    });
}

/**
 * Turns push off for this browser (and keeps it off until it is turned on again). A browser that keeps
 * its subscription is reported in `error` and unsubscribed again at the next sync.
 */
export function disablePushOnThisBrowser(): Promise<void> {
    queuedReconcile = null;
    return serial(async () => {
        writeRegistrationStamp(null);
        writeStored(OPTED_OUT_KEY, "1");
        update({ busy: true, optedOut: true, error: null });
        try {
            const registration = await readyRegistration();
            const subscription = await registration?.pushManager.getSubscription();
            if (subscription) {
                const endpoint = subscription.endpoint;
                const removed = await unsubscribed(subscription);
                writeStored(PENDING_UNSUBSCRIBE_KEY, removed ? null : "1");
                await removeOnServer(endpoint).catch(() => writeStored(PENDING_REMOVAL_KEY, endpoint));
                if (!removed) {
                    update({ error: language.pushNotifications.unsubscribeFailed });
                }
            }
            update({ subscribed: false });
        } catch (error) {
            update({ error: describe(error) });
        } finally {
            update({ busy: false });
        }
    });
}

/** "Later" on the banner: it does not come back. */
export function declinePushPrompt() {
    writeStored(PROMPT_DISMISSED_KEY, "1");
    update({ promptDismissed: true });
}

const fallbackNotifications = new Map<string, Set<Notification>>();

/**
 * Closes this browser's completion notifications of every chat (the page is in front, so they are
 * read): each chat has its own tag, so they are listed whole and picked by the tag's prefix. When it
 * closed any, a `push` `dismissedByPage` event records how many.
 */
async function dismissCompletionNotifications() {
    let count = 0;
    for (const [tag, notices] of fallbackNotifications) {
        if (isCompletionNotificationTag(tag)) {
            fallbackNotifications.delete(tag);
            for (const notification of notices) {
                notification.close();
                count++;
            }
        }
    }
    try {
        const registration = await readyRegistration();
        const shown = await registration?.getNotifications();
        for (const notification of shown ?? []) {
            if (isCompletionNotificationTag(notification.tag)) {
                notification.close();
                count++;
            }
        }
    } catch {}
    if (count > 0) {
        recordClientEvent({ kind: "push", phase: "dismissedByPage", count });
    }
}

/**
 * The tab's completion notice (`jobChannel.ts`). A browser subscribed to push shows the push instead
 * (the same chat's tag would replace it anyway); otherwise the worker's `showNotification`, else the page's
 * `Notification`. A page in front with the focus shows nothing, so the notification does not sound after
 * the page's message sound (`playMessage`, when on); another window of the app having the focus is not
 * seen here. Never asks for the permission.
 */
export async function showCompletionNotification(payload: {
    title: string;
    body: string;
    url: string;
    tag: string;
}): Promise<void> {
    if (currentPermission() !== "granted" || get(pushBrowserState).subscribed) {
        return;
    }
    if (document.visibilityState === "visible" && document.hasFocus()) {
        return;
    }
    const options = { body: payload.body, tag: payload.tag, icon: NOTIFICATION_ICON, badge: NOTIFICATION_ICON };
    try {
        const registration = await readyRegistration();
        if (registration) {
            await registration.showNotification(payload.title, { ...options, data: { url: payload.url } });
            return;
        }
    } catch {}
    try {
        const shown = new Notification(payload.title, options);
        const notices = fallbackNotifications.get(payload.tag) ?? new Set<Notification>();
        notices.add(shown);
        fallbackNotifications.set(payload.tag, notices);
        shown.onclose = () => {
            notices.delete(shown);
            if (notices.size === 0 && fallbackNotifications.get(payload.tag) === notices) {
                fallbackNotifications.delete(payload.tag);
            }
        };
        shown.onclick = () => {
            window.focus();
            openRoute(payload.url);
            shown.close();
        };
    } catch {}
}

/**
 * Starts this browser's push (once, after the router started): availability, the server key, the
 * worker's "open this chat" messages, its completion messages (`onCompletionPush` gets the chat of
 * every completion push the worker showed, from the payload's same-origin chat route; a push for no
 * chat is not reported), the foreground cleanup, and the first sync.
 */
export function startPushNotifications(
    options: { onCompletionPush?: (ref: { chaId: string; chatId: string }) => void } = {},
) {
    if (started) {
        return;
    }
    started = true;
    let availability = browserAvailability();
    update({
        availability: availability === "ok" ? "checking" : availability,
        permission: currentPermission(),
        optedOut: readStored(OPTED_OUT_KEY) === "1",
        promptDismissed: readStored(PROMPT_DISMISSED_KEY) === "1",
    });
    if ("serviceWorker" in navigator) {
        // A notification's click (`public/sw.js`): open its chat here, and answer so the worker does
        // not navigate the window instead.
        navigator.serviceWorker.addEventListener("message", (event) => {
            const data = event.data as { type?: unknown; url?: unknown } | null;
            if (typeof data?.url !== "string") {
                return;
            }
            if (data.type === "risu-open-route") {
                const opened = openRoute(data.url);
                event.ports[0]?.postMessage({ opened });
            } else if (data.type === "risu-push-completion") {
                // A completion the worker showed: the chat may have a reply this tab does not follow.
                const ref = parseChatRoutePath(data.url);
                if (ref) {
                    options.onCompletionPush?.(ref);
                }
            }
        });
    }
    if (document.visibilityState === "visible") {
        void dismissCompletionNotifications();
    }
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void dismissCompletionNotifications();
            void reconcilePush();
        }
    });
    void (async () => {
        if (availability === "ok") {
            try {
                if (!(await loadServerKey()).key) {
                    availability = "server-off";
                }
                keyJustRead = true;
            } catch (error) {
                console.error("[Push]", error);
            }
            update({ availability });
        }
        await reconcilePush();
    })().catch((error) => console.error("[Push]", error));
}
