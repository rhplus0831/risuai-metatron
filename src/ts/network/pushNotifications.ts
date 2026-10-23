import { get, writable } from "svelte/store";
import {
    isCompletionNotificationTag,
    NOTIFICATION_ICON,
    PUSH_KEY_PATH,
    PUSH_SUBSCRIPTION_PATH,
} from "../../../shared/notifications.ts";
import { language } from "../../lang";
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
 */

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

export type PushBrowserState = {
    availability: PushAvailability;
    permission: NotificationPermission | "unsupported";
    /** The server holds this browser's current subscription. */
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
const REGISTRATION_TIMEOUT_MS = 10_000;

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
/** Enable, disable, and sync run one at a time, in order. */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
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

/** The server's VAPID key, fetched once; null (and `server-off`) when push is off there. */
async function loadServerKey(): Promise<string | null> {
    if (serverKey) {
        return serverKey;
    }
    const response = await authFetch(PUSH_KEY_PATH);
    if (!response.ok) {
        throw new Error(language.pushNotifications.keyRequestFailed(response.status));
    }
    const body = (await response.json()) as { publicKey?: unknown };
    serverKey = typeof body.publicKey === "string" && body.publicKey ? body.publicKey : null;
    if (!serverKey) {
        update({ availability: "server-off" });
    }
    return serverKey;
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
        if (subscription && !(await unsubscribed(subscription))) {
            update({ error: language.pushNotifications.unsubscribeFailed });
            return;
        }
        writeStored(PENDING_UNSUBSCRIBE_KEY, null);
    } catch {}
}

/**
 * Registers this browser's subscription with the server, creating it (or replacing one made for an
 * old server key) first. Needs the permission granted; creating a subscription may need a click on
 * some browsers, so a failure here is reported, not fatal.
 */
async function ensureSubscribed(): Promise<void> {
    const key = await loadServerKey();
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
        const stale = subscription.endpoint;
        const removed = await unsubscribed(subscription);
        await removeOnServer(stale).catch(() => writeStored(PENDING_REMOVAL_KEY, stale));
        if (!removed) {
            // The browser refuses a new key while it holds the old subscription; the next sync retries.
            throw new Error(language.pushNotifications.unsubscribeFailed);
        }
        subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key),
    });
    const response = await authFetch(PUSH_SUBSCRIPTION_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    if (!response.ok) {
        throw new Error(language.pushNotifications.registrationRefused(response.status));
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
 */
export function reconcilePush(): Promise<void> {
    if (!started) {
        return Promise.resolve();
    }
    return serial(async () => {
        const permission = currentPermission();
        let optedOut = readStored(OPTED_OUT_KEY) === "1";
        update({ permission, optedOut, promptDismissed: readStored(PROMPT_DISMISSED_KEY) === "1" });
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
            await ensureSubscribed();
        } catch (error) {
            update({ subscribed: false, error: describe(error) });
        }
    });
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
            await ensureSubscribed();
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
    writeStored(OPTED_OUT_KEY, "1");
    return serial(async () => {
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

/**
 * Closes this browser's completion notifications of every chat (the page is in front, so they are
 * read): each chat has its own tag, so they are listed whole and picked by the tag's prefix.
 */
async function dismissCompletionNotifications() {
    try {
        const registration = await readyRegistration();
        const shown = await registration?.getNotifications();
        for (const notification of shown ?? []) {
            if (isCompletionNotificationTag(notification.tag)) {
                notification.close();
            }
        }
    } catch {}
}

/**
 * The tab's completion notice (`jobChannel.ts`). A browser subscribed to push shows the push instead
 * (the same chat's tag would replace it anyway); otherwise the worker's `showNotification`, else the page's
 * `Notification`. Never asks for the permission.
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
        shown.onclick = () => {
            window.focus();
            openRoute(payload.url);
            shown.close();
        };
    } catch {}
}

/**
 * Starts this browser's push (once, after the router started): availability, the server key, the
 * worker's "open this chat" messages, the foreground cleanup, and the first sync.
 */
export function startPushNotifications() {
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
            if (data?.type !== "risu-open-route" || typeof data.url !== "string") {
                return;
            }
            const opened = openRoute(data.url);
            event.ports[0]?.postMessage({ opened });
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
                if (!(await loadServerKey())) {
                    availability = "server-off";
                }
            } catch (error) {
                console.error("[Push]", error);
            }
            update({ availability });
        }
        await reconcilePush();
    })().catch((error) => console.error("[Push]", error));
}
