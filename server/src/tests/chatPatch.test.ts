// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import { chatBaseline, diffChat } from "../jobs/generationJobs.ts";

// The job chat's `chatPatch` body (`server/src/jobs/generationJobs.ts` `diffChat`): the change
// between two stored states of the job chat, as the registry sends it instead of the whole chat.
// The registry's routing of patches over the owner socket is covered by `generations.test.ts`.

const EPOCH = "11111111-2222-4333-8444-555555555555";
const token = (revision: number, seq = 1, epoch = EPOCH) => `${epoch}:${seq}:${revision}`;
const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const chat = (messages: ReturnType<typeof m>[], meta: Record<string, unknown> = {}): Chat =>
    ({ id: "k", name: "K", note: "", localLore: [], ...meta, message: messages }) as unknown as Chat;
const none = new Set<string>();
const ids = (patch: { messages?: { after: string | null; message: unknown }[] } | null) =>
    patch?.messages?.map((row) => [(row.message as { chatId: string }).chatId, row.after]);

describe("chatBaseline", () => {
    it("keeps the revision, the message ids in order, each message's text, and the meta without the messages", () => {
        const data = chat([m("a", "A"), m("b", "B", "char")], { note: "n" });
        const base = chatBaseline(token(3), data);
        expect(base.revision).toBe(token(3));
        expect(base.ids).toEqual(["a", "b"]);
        expect(base.texts.get("b")).toBe(JSON.stringify(m("b", "B", "char")));
        expect(JSON.parse(base.meta)).toEqual({ id: "k", name: "K", note: "n", localLore: [] });
        expect(base.meta).not.toContain('"message"');
    });
});

describe("diffChat", () => {
    const before = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
    const base = chatBaseline(token(1), before);

    it("is only the count when nothing changed", () => {
        expect(diffChat(base, chatBaseline(token(1), before), before, none)).toEqual({ count: 3 });
    });

    it("carries a changed message with the id before it, and nothing else", () => {
        const after = chat([m("a", "A"), m("b", "B edited", "char"), m("c", "C")]);
        const patch = diffChat(base, chatBaseline(token(2), after), after, none);
        expect(patch).toEqual({
            messages: [{ after: "a", message: m("b", "B edited", "char") }],
            count: 3,
        });
        expect(patch).not.toHaveProperty("meta");
        expect(patch).not.toHaveProperty("removed");
    });

    it("carries inserted messages at the start (after null), in the middle, and at the end, in stored order", () => {
        const after = chat([m("s", "S"), m("a", "A"), m("x", "X"), m("b", "B", "char"), m("c", "C"), m("e", "E")]);
        const patch = diffChat(base, chatBaseline(token(2), after), after, none);
        expect(ids(patch)).toEqual([
            ["s", null],
            ["x", "a"],
            ["e", "c"],
        ]);
        expect(patch!.count).toBe(6);
    });

    it("names the removed ids, and anchors the message after a removed one on its surviving predecessor", () => {
        const after = chat([m("a", "A"), m("c", "C edited")]);
        const patch = diffChat(base, chatBaseline(token(2), after), after, none);
        expect(patch).toEqual({ removed: ["b"], messages: [{ after: "a", message: m("c", "C edited") }], count: 2 });
    });

    it("carries the meta only when it changed, as the chat's fields without the messages", () => {
        const same = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), same), same, none)).toEqual({ count: 3 });
        const renamed = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")], { name: "Renamed", note: "n" });
        const patch = diffChat(base, chatBaseline(token(2), renamed), renamed, none);
        expect(patch).toEqual({ meta: { id: "k", name: "Renamed", note: "n", localLore: [] }, count: 3 });
    });

    it("always carries the rows of the messages the job began a generation on, changed or not, and only those still stored", () => {
        const generated = new Set(["b", "gone"]);
        expect(diffChat(base, chatBaseline(token(1), before), before, generated)).toEqual({
            messages: [{ after: "a", message: m("b", "B", "char") }],
            count: 3,
        });
        // A generated message removed meanwhile is in `removed`, not in `messages`.
        const after = chat([m("a", "A"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), after), after, new Set(["b"]))).toEqual({
            removed: ["b"],
            count: 2,
        });
    });

    it("gives up (the chat goes whole) when the surviving messages changed their relative order", () => {
        const reordered = chat([m("b", "B", "char"), m("a", "A"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), reordered), reordered, none)).toBeNull();
        // A reorder among survivors with insertions and removals around it is still a reorder.
        const mixed = chat([m("n", "N"), m("c", "C"), m("a", "A")]);
        expect(diffChat(base, chatBaseline(token(2), mixed), mixed, none)).toBeNull();
    });

    it("gives up for another incarnation or epoch, an older revision, and a missing or repeated id", () => {
        const after = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2, 2), after), after, none)).toBeNull();
        expect(
            diffChat(base, chatBaseline(token(2, 1, "22222222-2222-4333-8444-555555555555"), after), after, none),
        ).toBeNull();
        expect(diffChat(base, chatBaseline(token(0), after), after, none)).toBeNull();
        const missing = chat([m("a", "A"), { role: "user", data: "no id" } as never, m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), missing), missing, none)).toBeNull();
        const repeated = chat([m("a", "A"), m("a", "A again"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), repeated), repeated, none)).toBeNull();
    });

    it("expresses the state at the later revision, not the path: a change reverted before the diff is not a change", () => {
        // Edited at revision 2 and restored at revision 3: the 1 -> 3 patch carries nothing of it.
        const restored = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(3), restored), restored, none)).toEqual({ count: 3 });
    });
});
