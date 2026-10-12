/**
 * Chat completion notifications (`docs/plan/web-push.md`): the text the server builds once, for the
 * tab's `notification` notice and for Web Push alike, and the payload shape the service worker shows.
 */

export const COMPLETION_NOTIFICATION_TAG = "risuai-chat-completion";
/** `GET`: `{ publicKey }` (null while push is off on the server). */
export const PUSH_KEY_PATH = "/api/push/key";
/** `PUT { subscription }` registers this browser; `DELETE { endpoint }` removes it. */
export const PUSH_SUBSCRIPTION_PATH = "/api/push/subscription";
export const COMPLETION_NOTIFICATION_TITLE = "Risuai";
export const NOTIFICATION_ICON = "/logo_192.png";
/** `{name}` in the default sentence is cut to this many graphemes (plus `…`). */
export const MAX_NOTIFICATION_NAME_GRAPHEMES = 20;
/** The body's UTF-8 ceiling, before the whole payload's budget. */
export const MAX_NOTIFICATION_BODY_BYTES = 1024;
/**
 * The serialized push payload's UTF-8 ceiling. Push services accept about 4 KiB after encryption
 * (which adds about 100 bytes), so this leaves a margin.
 */
export const MAX_PUSH_PAYLOAD_BYTES = 3000;
/** The serialized body a route must leave room for, or the route becomes `/`. */
const MIN_BODY_ROOM_BYTES = 256;

/** What the service worker and the tab show for one completion. */
export type CompletionNotification = {
    title: string;
    body: string;
    /** The chat's client route (`/chat/<chaId>/<chatId>`), or `/` when that does not fit. */
    url: string;
    tag: string;
    icon: string;
    badge: string;
};

const ELLIPSIS = "…";

function graphemes(text: string): string[] {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
}

function utf8Bytes(text: string): number {
    return new TextEncoder().encode(text).byteLength;
}

/** `text` cut to `max` graphemes, with `…` when it was cut. */
export function truncateGraphemes(text: string, max: number): string {
    const parts = graphemes(text);
    return parts.length <= max ? text : parts.slice(0, max).join("").trimEnd() + ELLIPSIS;
}

/** `text` cut on a grapheme boundary so it is at most `maxBytes` UTF-8 bytes, `…` included. */
export function capUtf8Bytes(text: string, maxBytes: number): string {
    if (utf8Bytes(text) <= maxBytes) {
        return text;
    }
    const budget = maxBytes - utf8Bytes(ELLIPSIS);
    let kept = "";
    let used = 0;
    for (const part of graphemes(text)) {
        const size = utf8Bytes(part);
        if (used + size > budget) {
            break;
        }
        kept += part;
        used += size;
    }
    return kept.trimEnd() + ELLIPSIS;
}

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * The notification body: the character's (or group's) `customNotificationMessage` when it has one,
 * else the default sentence in the `language` setting (Korean for `ko`, English otherwise) naming
 * the character. Tolerates any stored value: a field that is not a string counts as unset.
 */
export function completionNotificationBody(arg: { name: unknown; customMessage: unknown; language: unknown }): string {
    const custom = asText(arg.customMessage);
    if (custom) {
        return capUtf8Bytes(custom, MAX_NOTIFICATION_BODY_BYTES);
    }
    const name = truncateGraphemes(asText(arg.name) || COMPLETION_NOTIFICATION_TITLE, MAX_NOTIFICATION_NAME_GRAPHEMES);
    const sentence =
        arg.language === "ko" ? `${name}의 메시지 처리가 완료되었습니다` : `${name}'s message has been processed.`;
    return capUtf8Bytes(sentence, MAX_NOTIFICATION_BODY_BYTES);
}

/** The chat's client route, as `formatRoute` (`src/ts/router/routes.ts`) writes it. */
export function chatRoutePath(chaId: string, chatId: string): string {
    return `/chat/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`;
}

/**
 * The completion notification for a chat, its serialized form within `MAX_PUSH_PAYLOAD_BYTES`: a
 * route too long for the budget becomes `/`, then the body is cut further.
 */
export function completionNotification(arg: {
    name: unknown;
    customMessage: unknown;
    language: unknown;
    chaId: string;
    chatId: string;
}): CompletionNotification {
    const notification: CompletionNotification = {
        title: COMPLETION_NOTIFICATION_TITLE,
        body: completionNotificationBody(arg),
        url: chatRoutePath(arg.chaId, arg.chatId),
        tag: COMPLETION_NOTIFICATION_TAG,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_ICON,
    };
    const size = () => utf8Bytes(JSON.stringify(notification));
    // The route goes only when it leaves no room for a short body; a body over the budget is cut instead.
    if (utf8Bytes(JSON.stringify({ ...notification, body: "" })) > MAX_PUSH_PAYLOAD_BYTES - MIN_BODY_ROOM_BYTES) {
        notification.url = "/";
    }
    // JSON escaping can grow the body (control characters, quotes): cut it until the whole fits.
    let budget = MAX_NOTIFICATION_BODY_BYTES;
    while (size() > MAX_PUSH_PAYLOAD_BYTES && budget > 0) {
        budget = Math.floor(budget / 2);
        notification.body = capUtf8Bytes(notification.body, budget);
    }
    return notification;
}
