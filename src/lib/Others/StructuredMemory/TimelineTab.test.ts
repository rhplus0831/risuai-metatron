// @vitest-environment happy-dom
// Open in Manage opens the row as a press does: it reads the record again even when Read had it open.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import TimelineTab from "./TimelineTab.svelte";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>() }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch }),
);
const ref = { chaId: "owner", chatId: "chat" };
const route = "/api/memory/structured/owner/chat";
const target = document.createElement("div");
let mounted: ReturnType<typeof mount> | undefined;
async function settle() {
    for (let i = 0; i < 50; i++) {
        await Promise.resolve();
        flushSync();
    }
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50; i++) {
        await Promise.resolve();
        flushSync();
    }
}
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    target.remove();
    vi.useRealTimers();
    authFetch.mockReset();
});

it.each(["first read failed", "first read succeeded"])(
    "Open in Manage reads the event again after the %s",
    async (initial) => {
        vi.useFakeTimers();
        document.body.appendChild(target);
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "owner",
                    type: "character",
                    name: "Owner",
                    firstMessage: "",
                    chats: [{ id: "chat", name: "Chat", note: "", localLore: [], message: [] }],
                },
            ],
            memoryAlgorithmType: "structuredMemory",
        });
        let count = 0;
        const record = { id: "e", title: "Event", summary: "Original summary", participants: [], keyLines: [] };
        authFetch.mockImplementation(async (url) => {
            if (url === route + "/coverage")
                return Response.json({
                    revision: "r1",
                    events: [{ id: "e", title: "Event", status: "active", messageIds: [], sources: [] }],
                    runs: [],
                    next: null,
                });
            if (url === route + "/story") return Response.json({ revision: "r1", events: [{ ...record }], next: null });
            if (url === route + "/chapters") return Response.json({ revision: "r1", chapters: [] });
            if (url === route) return Response.json({ revision: "r1", pages: [], events: [], threads: [], runs: [] });
            if (url === route + "/records/events/e") {
                count++;
                if (initial === "first read failed" && count === 1)
                    return Response.json({ error: "Record temporarily unavailable" }, { status: 503 });
                return Response.json({ revision: count === 1 ? "r1" : "r2", data: { ...record } });
            }
            throw Error("Unexpected request " + url);
        });
        mounted = mount(TimelineTab, {
            target,
            props: { chatRef: ref, readOnly: false, refresh: 0, focus: null, open: vi.fn(), jump: vi.fn() },
        });
        await settle();
        const toggle = () => target.querySelector<HTMLButtonElement>('[data-memory-event="e"] > button')!;
        toggle().click();
        await settle();
        expect(count).toBe(1);
        record.summary = "Current summary";
        target.querySelector<HTMLButtonElement>("[data-memory-open-in-manage]")!.click();
        await settle();
        const snapshot = {
            gets: count,
            expanded: toggle().getAttribute("aria-expanded"),
            error: target.querySelector('[data-memory-event="e"] [role=alert]')?.textContent.trim() ?? null,
            summary:
                target.querySelector('[data-memory-event="e"] [data-memory-event-summary]')?.textContent.trim() ?? null,
        };
        expect(snapshot).toEqual({ gets: 2, expanded: "true", error: null, summary: "Current summary" });
    },
);

// The link rereads the record but keeps an open editor: only a changed stored record closes it.
it.each(["Manage segment", "Open in Manage link"])(
    "keeps an unfinished correction to the open event when Read returns through the %s",
    async (wayBack) => {
        vi.useFakeTimers();
        document.body.appendChild(target);
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "owner",
                    type: "character",
                    name: "Owner",
                    firstMessage: "",
                    chats: [{ id: "chat", name: "Chat", note: "", localLore: [], message: [] }],
                },
            ],
            memoryAlgorithmType: "structuredMemory",
        });
        let count = 0;
        const record = { id: "e", title: "Event", summary: "Original summary", participants: [], keyLines: [] };
        authFetch.mockImplementation(async (url) => {
            if (url === route + "/coverage")
                return Response.json({
                    revision: "r1",
                    events: [{ id: "e", title: "Event", status: "active", messageIds: [], sources: [] }],
                    runs: [],
                    next: null,
                });
            if (url === route + "/story") return Response.json({ revision: "r1", events: [{ ...record }], next: null });
            if (url === route + "/chapters") return Response.json({ revision: "r1", chapters: [] });
            if (url === route) return Response.json({ revision: "r1", pages: [], events: [], threads: [], runs: [] });
            if (url === route + "/records/events/e") {
                count++;
                return Response.json({ revision: "r1", data: { ...record } });
            }
            throw Error("Unexpected request " + url);
        });
        mounted = mount(TimelineTab, {
            target,
            props: { chatRef: ref, readOnly: false, refresh: 0, focus: null, open: vi.fn(), jump: vi.fn() },
        });
        await settle();
        const toggle = () => target.querySelector<HTMLButtonElement>('[data-memory-event="e"] > button')!;
        const draft = () => target.querySelector<HTMLTextAreaElement>("[data-memory-event-editor] textarea");
        const edit = () => target.querySelector<HTMLElement>("[data-memory-event-edit]")!.closest("button")!.click();
        async function segment(name: string) {
            const button = Array.from(target.querySelectorAll<HTMLButtonElement>("[data-segment-btn]")).find(
                (node) => node.textContent?.trim() === name,
            );
            expect(button).toBeDefined();
            button!.click();
            await settle();
        }
        await segment("Manage");
        toggle().click();
        await settle();
        edit();
        await settle();
        const text = "Unfinished correction about the gate";
        draft()!.value = text;
        draft()!.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        expect(draft()!.value).toBe(text);
        await segment("Read");
        expect(toggle().getAttribute("aria-expanded")).toBe("true");
        if (wayBack === "Manage segment") {
            await segment("Manage");
        } else {
            target.querySelector<HTMLButtonElement>("[data-memory-open-in-manage]")!.click();
            await settle();
            expect(count).toBe(2);
        }
        const editorStayedOpen = draft() !== null;
        if (!editorStayedOpen) {
            edit();
            await settle();
        }
        expect(authFetch.mock.calls.some(([url]) => url.endsWith("/edits"))).toBe(false);
        expect({ editorStayedOpen, text: draft()?.value }).toEqual({ editorStayedOpen: true, text });
    },
);

// A restored partial event (no string summary) reads as "" in the view the editor starts from.
it.each([undefined, null])(
    "keeps an unfinished correction to an open event stored with a %s summary when Read returns through the link",
    async (stored) => {
        const wayBack: string = "Open in Manage link";
        vi.useFakeTimers();
        document.body.appendChild(target);
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "owner",
                    type: "character",
                    name: "Owner",
                    firstMessage: "",
                    chats: [{ id: "chat", name: "Chat", note: "", localLore: [], message: [] }],
                },
            ],
            memoryAlgorithmType: "structuredMemory",
        });
        let count = 0;
        const record: Record<string, unknown> = { id: "e", title: "Event", participants: [], keyLines: [] };
        if (stored === null) record.summary = null;
        authFetch.mockImplementation(async (url) => {
            if (url === route + "/coverage")
                return Response.json({
                    revision: "r1",
                    events: [{ id: "e", title: "Event", status: "active", messageIds: [], sources: [] }],
                    runs: [],
                    next: null,
                });
            if (url === route + "/story") return Response.json({ revision: "r1", events: [{ ...record }], next: null });
            if (url === route + "/chapters") return Response.json({ revision: "r1", chapters: [] });
            if (url === route) return Response.json({ revision: "r1", pages: [], events: [], threads: [], runs: [] });
            if (url === route + "/records/events/e") {
                count++;
                return Response.json({ revision: "r1", data: { ...record } });
            }
            throw Error("Unexpected request " + url);
        });
        mounted = mount(TimelineTab, {
            target,
            props: { chatRef: ref, readOnly: false, refresh: 0, focus: null, open: vi.fn(), jump: vi.fn() },
        });
        await settle();
        const toggle = () => target.querySelector<HTMLButtonElement>('[data-memory-event="e"] > button')!;
        const draft = () => target.querySelector<HTMLTextAreaElement>("[data-memory-event-editor] textarea");
        const edit = () => target.querySelector<HTMLElement>("[data-memory-event-edit]")!.closest("button")!.click();
        async function segment(name: string) {
            const button = Array.from(target.querySelectorAll<HTMLButtonElement>("[data-segment-btn]")).find(
                (node) => node.textContent?.trim() === name,
            );
            expect(button).toBeDefined();
            button!.click();
            await settle();
        }
        await segment("Manage");
        toggle().click();
        await settle();
        edit();
        await settle();
        const text = "Unfinished correction about the gate";
        draft()!.value = text;
        draft()!.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        expect(draft()!.value).toBe(text);
        await segment("Read");
        expect(toggle().getAttribute("aria-expanded")).toBe("true");
        if (wayBack === "Manage segment") {
            await segment("Manage");
        } else {
            target.querySelector<HTMLButtonElement>("[data-memory-open-in-manage]")!.click();
            await settle();
            expect(count).toBe(2);
        }
        const editorStayedOpen = draft() !== null;
        if (!editorStayedOpen) {
            edit();
            await settle();
        }
        expect(authFetch.mock.calls.some(([url]) => url.endsWith("/edits"))).toBe(false);
        expect({ editorStayedOpen, text: draft()?.value }).toEqual({ editorStayedOpen: true, text });
    },
);
