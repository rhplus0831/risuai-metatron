// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    capUtf8Bytes,
    chatRoutePath,
    completionNotification,
    completionNotificationBody,
    COMPLETION_NOTIFICATION_TAG,
    COMPLETION_NOTIFICATION_TITLE,
    MAX_NOTIFICATION_BODY_BYTES,
    MAX_PUSH_PAYLOAD_BYTES,
    NOTIFICATION_ICON,
    truncateGraphemes,
} from "../notifications.ts";

// `docs/plan/web-push.md` slice 1: the completion notification's text (the custom message, else the
// default sentence by the `language` setting with the name cut to 20 graphemes), the body's 1 KiB
// ceiling, the chat route, and the serialized payload budget (Astra plan review, point 4).

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

describe("completionNotificationBody", () => {
    it("uses the character's custom message when it has one, trimmed", () => {
        expect(completionNotificationBody({ name: "Ann", customMessage: "  Dinner is ready  ", language: "ko" })).toBe(
            "Dinner is ready",
        );
    });

    it("falls back to the default sentence of the language setting: Korean for `ko`, English otherwise", () => {
        const base = { customMessage: "", language: "ko" };
        expect(completionNotificationBody({ ...base, name: "Ann" })).toBe("Ann의 메시지 처리가 완료되었습니다");
        expect(completionNotificationBody({ name: "Ann", customMessage: "   ", language: "en" })).toBe(
            "Ann's message has been processed.",
        );
        expect(completionNotificationBody({ name: "Ann", customMessage: undefined, language: "de" })).toBe(
            "Ann's message has been processed.",
        );
        expect(completionNotificationBody({ name: "Ann", customMessage: undefined, language: undefined })).toBe(
            "Ann's message has been processed.",
        );
    });

    it("cuts the name to 20 graphemes with an ellipsis, counting a combined emoji as one", () => {
        const long = "A".repeat(25);
        expect(completionNotificationBody({ name: long, customMessage: "", language: "en" })).toBe(
            `${"A".repeat(20)}…'s message has been processed.`,
        );
        const family = "👨‍👩‍👧‍👦";
        const twenty = family.repeat(20);
        expect(completionNotificationBody({ name: twenty, customMessage: "", language: "en" })).toBe(
            `${twenty}'s message has been processed.`,
        );
        expect(completionNotificationBody({ name: twenty + family, customMessage: "", language: "en" })).toBe(
            `${twenty}…'s message has been processed.`,
        );
    });

    it("tolerates stored values that are not strings: a missing or blank name becomes the app's name, a non-string custom message counts as unset", () => {
        expect(completionNotificationBody({ name: "", customMessage: 42, language: "en" })).toBe(
            `${COMPLETION_NOTIFICATION_TITLE}'s message has been processed.`,
        );
        expect(completionNotificationBody({ name: null, customMessage: { a: 1 }, language: "ko" })).toBe(
            `${COMPLETION_NOTIFICATION_TITLE}의 메시지 처리가 완료되었습니다`,
        );
        expect(completionNotificationBody({ name: 7, customMessage: ["x"], language: 3 })).toBe(
            `${COMPLETION_NOTIFICATION_TITLE}'s message has been processed.`,
        );
    });

    it("caps a custom message at 1 KiB of UTF-8 on a grapheme boundary", () => {
        const custom = "가".repeat(600); // 1800 bytes
        const body = completionNotificationBody({ name: "Ann", customMessage: custom, language: "ko" });
        expect(utf8(body)).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_BYTES);
        expect(body.endsWith("…")).toBe(true);
        // 340 * 3 = 1020 bytes, plus the 3-byte ellipsis: 1023 (a cut never lands inside a character).
        expect(body).toBe("가".repeat(340) + "…");
    });
});

describe("truncateGraphemes and capUtf8Bytes", () => {
    it("leave a short text alone and trim the space before the ellipsis", () => {
        expect(truncateGraphemes("abc", 3)).toBe("abc");
        expect(truncateGraphemes("ab cd", 3)).toBe("ab…");
        expect(capUtf8Bytes("abc", 3)).toBe("abc");
        expect(capUtf8Bytes("ab cdef", 6)).toBe("ab…");
    });

    it("never return more than the byte budget once a cut is needed", () => {
        for (const text of ["é".repeat(50), "a😀".repeat(40), "한글 텍스트 ".repeat(30)]) {
            for (const max of [8, 16, 33, 100]) {
                expect(utf8(capUtf8Bytes(text, max)), `${text.slice(0, 4)} @ ${max}`).toBeLessThanOrEqual(max);
            }
        }
    });
});

describe("chatRoutePath", () => {
    it("writes the client's chat route with both ids percent-encoded, as `formatRoute` does", () => {
        expect(chatRoutePath("c1", "k")).toBe("/chat/c1/k");
        expect(chatRoutePath("§playground", "a/b")).toBe("/chat/%C2%A7playground/a%2Fb");
        expect(chatRoutePath("a b", "c?d#e")).toBe("/chat/a%20b/c%3Fd%23e");
    });
});

describe("completionNotification", () => {
    const base = { name: "Ann", customMessage: "", language: "en", chaId: "c1", chatId: "k" };

    it("carries the fixed title, tag, and logo icon with the chat's route", () => {
        expect(completionNotification(base)).toEqual({
            title: COMPLETION_NOTIFICATION_TITLE,
            body: "Ann's message has been processed.",
            url: "/chat/c1/k",
            tag: COMPLETION_NOTIFICATION_TAG,
            icon: NOTIFICATION_ICON,
            badge: NOTIFICATION_ICON,
        });
    });

    it("keeps the serialized payload within the push budget: a route too long becomes `/`", () => {
        // Two ids of 512 UTF-16 units (`isValidResourceId`'s cap) of Korean: about 9 KiB once encoded.
        const chaId = "가".repeat(512);
        const chatId = "나".repeat(512);
        const custom = "x".repeat(1024);
        const notification = completionNotification({ ...base, customMessage: custom, chaId, chatId });
        expect(notification.url).toBe("/");
        expect(notification.body).toBe(custom);
        expect(utf8(JSON.stringify(notification))).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
    });

    it("keeps the serialized payload within the push budget: a body whose JSON escaping grows is cut further", () => {
        // 1 KiB of control characters: 6 bytes each once serialized (`\u0001`).
        const custom = "\u0001".repeat(MAX_NOTIFICATION_BODY_BYTES);
        const notification = completionNotification({ ...base, customMessage: custom });
        const serialized = JSON.stringify(notification);
        expect(utf8(serialized)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
        expect(notification.body.length).toBeLessThan(custom.length);
        expect(notification.body.endsWith("…")).toBe(true);
        // The worker reads the payload back as JSON.
        expect(JSON.parse(serialized)).toEqual(notification);
    });

    // The function's contract: a route too long for the budget becomes `/`; a body over the budget is
    // cut, and a short route survives it.
    it("keeps a short route when the body alone is what exceeds the budget", () => {
        const custom = "\u0001".repeat(MAX_NOTIFICATION_BODY_BYTES);
        const notification = completionNotification({ ...base, customMessage: custom });
        expect(utf8(JSON.stringify(notification))).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
        expect(notification.url).toBe("/chat/c1/k");
        expect(notification.body.endsWith("…")).toBe(true);
    });

    it("keeps a long route that leaves room for a short body, cutting the body to that room", () => {
        // About 2.5 KiB of route: kept, with the body cut to what is left.
        const chaId = "가".repeat(270); // 270 * 9 bytes percent-encoded = 2430
        const notification = completionNotification({ ...base, customMessage: "x".repeat(1024), chaId });
        expect(notification.url).toBe(chatRoutePath(chaId, "k"));
        expect(utf8(JSON.stringify(notification))).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
        expect(notification.body.length).toBeGreaterThan(0);
        expect(notification.body.length).toBeLessThan(1024);
        // One step longer than the room allows: the route goes and the body stays whole.
        const longer = completionNotification({ ...base, customMessage: "x".repeat(1024), chaId: "가".repeat(310) });
        expect(longer.url).toBe("/");
        expect(longer.body).toBe("x".repeat(1024));
    });

    it("uses the group's own name and message when the owner is a group", () => {
        const notification = completionNotification({
            name: "The Crew",
            customMessage: "Crew is done",
            language: "ko",
            chaId: "grp",
            chatId: "k",
        });
        expect(notification.body).toBe("Crew is done");
        expect(notification.url).toBe("/chat/grp/k");
    });
});
