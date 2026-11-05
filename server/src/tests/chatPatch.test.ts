// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import type { ChatWriteChange } from "../data/chatStore.ts";
import { advanceChatBaseline, baselineText, chatBaseline, diffChat } from "../jobs/generationJobs.ts";

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
        expect(baselineText(base, "b")).toBe(JSON.stringify(m("b", "B", "char")));
        expect(JSON.parse(base.meta)).toEqual({ id: "k", name: "K", note: "n", localLore: [] });
        expect(base.meta).not.toContain('"message"');
    });
});

describe("incremental chat checkpoints", () => {
    const row = (id: string, after: string | null, data: string) => ({
        id,
        after,
        data: JSON.stringify(m(id, data)),
    });
    const change = (
        revision: number,
        count: number,
        rows: ChatWriteChange["rows"],
        removed: string[] = [],
    ): ChatWriteChange => ({
        baseRevision: token(revision - 1),
        revision: token(revision),
        count,
        rows,
        removed,
    });

    it("bounds id reads and Map copies for each one-row checkpoint in a 10,000-message chat", () => {
        let base = chatBaseline(token(1), chat(Array.from({ length: 10_000 }, (_, index) => m(String(index)))));
        let operations = { ids: 0, maps: 0, entries: 0 };
        base = {
            ...base,
            ids: new Proxy(base.ids, {
                get(target, key, receiver) {
                    if (typeof key === "string" && /^\d+$/.test(key)) operations.ids++;
                    return Reflect.get(target, key, receiver);
                },
            }),
        };
        class CountedMap<K, V> extends Map<K, V> {
            constructor(entries?: Iterable<readonly [K, V]> | null) {
                super(entries);
                operations.maps++;
            }
            override set(key: K, value: V): this {
                operations.entries++;
                return super.set(key, value);
            }
        }
        let previous = "";
        for (const [index, text] of ["first", "second", "", "fourth"].entries()) {
            const written = change(index + 2, 10_000, [row("5000", "4999", text)]);
            operations = { ids: 0, maps: 0, entries: 0 };
            vi.stubGlobal("Map", CountedMap);
            let next: ReturnType<typeof advanceChatBaseline>;
            let patch: ReturnType<typeof diffChat>;
            let stored: string | undefined;
            let before: string | undefined;
            try {
                next = advanceChatBaseline(base, written);
                if (!next) throw new Error("An in-place checkpoint must advance the baseline");
                patch = diffChat(base, next, none);
                stored = baselineText(next, "5000");
                before = baselineText(base, "5000");
            } finally {
                vi.unstubAllGlobals();
            }
            // A fixed allowance for a single changed row, independent of the history length.
            expect(operations.maps).toBeLessThanOrEqual(8);
            expect(operations.entries).toBeLessThanOrEqual(32);
            expect(operations.ids).toBeLessThanOrEqual(32);
            expect(patch).toEqual({ count: 10_000, messages: [{ after: "4999", message: m("5000", text) }] });
            expect(stored).toBe(JSON.stringify(m("5000", text)));
            expect(before).toBe(JSON.stringify(m("5000", previous)));
            base = next!;
            previous = text;
        }
    });

    it("preserves the general fallback for removals, insertions, reorders, and malformed changes", () => {
        const initial = chatBaseline(token(1), chat([m("a", "A"), m("b", "B"), m("c", "C")]));
        const base = advanceChatBaseline(initial, change(2, 3, [row("b", "a", "B edited")]))!;
        const cases = [
            {
                written: change(3, 2, [], ["a"]),
                messages: [m("b", "B edited"), m("c", "C")],
                patch: { count: 2, removed: ["a"] },
            },
            {
                written: change(3, 4, [row("x", "b", "X")]),
                messages: [m("a", "A"), m("b", "B edited"), m("x", "X"), m("c", "C")],
                patch: { count: 4, messages: [{ after: "b", message: m("x", "X") }] },
            },
            {
                written: change(3, 3, [row("c", null, "C")]),
                messages: [m("c", "C"), m("a", "A"), m("b", "B edited")],
                patch: null,
            },
        ];
        for (const { written, messages, patch } of cases) {
            const next = advanceChatBaseline(base, written)!;
            expect(next).not.toBeNull();
            expect(next.ids).toEqual(messages.map((message) => message.chatId));
            expect(next.ids.map((id) => JSON.parse(baselineText(next, id)!))).toEqual(messages);
            expect(baselineText(next, "a")).toBe(written.removed.length ? undefined : JSON.stringify(m("a", "A")));
            expect(diffChat(base, next, none)).toEqual(patch);
            expect(diffChat(base, chatBaseline(token(3), chat(messages)), none)).toEqual(patch);
        }
        expect(advanceChatBaseline(base, change(3, 3, [row("b", "a", "one"), row("b", "a", "two")]))).toBeNull();
        expect(advanceChatBaseline(base, change(3, 3, [row("b", "missing", "bad anchor")]))).toBeNull();
        expect(advanceChatBaseline(base, change(3, 4, [row("b", "a", "bad count")]))).toBeNull();
        expect(base.ids.map((id) => JSON.parse(baselineText(base, id)!))).toEqual([
            m("a", "A"),
            m("b", "B edited"),
            m("c", "C"),
        ]);
    });

    it("matches the general diff in stored order, including generated rows and reverted edits", () => {
        const original = chat([m("a", "A"), m("b", "B"), m("c", "C"), m("d", "D")]);
        const initial = chatBaseline(token(1), original);
        const base = advanceChatBaseline(initial, change(2, 4, [row("c", "b", "C edited")]))!;
        const reverted = advanceChatBaseline(base, change(3, 4, [row("c", "b", "C")]))!;
        expect(diffChat(initial, reverted, none)).toEqual({ count: 4 });
        const final = chat([m("a", "A edited"), m("b", "B"), m("c", "C"), m("d", "D")], { note: "changed" });
        const next = advanceChatBaseline(reverted, {
            ...change(4, 4, [row("a", null, "A edited")]),
            meta: JSON.stringify(final),
        })!;
        const generated = new Set(["d", "missing", "b"]);
        const expected = {
            count: 4,
            meta: { id: "k", name: "K", note: "changed", localLore: [] },
            messages: [
                { after: null, message: m("a", "A edited") },
                { after: "a", message: m("b", "B") },
                { after: "b", message: m("c", "C") },
                { after: "c", message: m("d", "D") },
            ],
        };
        const indexed = diffChat(base, next, generated);
        const general = diffChat(base, chatBaseline(token(4), final), generated);
        expect(indexed).toEqual(expected);
        expect(general).toEqual(expected);
        expect(indexed).toEqual(general);
    });
});

describe("diffChat", () => {
    const before = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
    const base = chatBaseline(token(1), before);

    it("is only the count when nothing changed", () => {
        expect(diffChat(base, chatBaseline(token(1), before), none)).toEqual({ count: 3 });
    });

    it("carries a changed message with the id before it, and nothing else", () => {
        const after = chat([m("a", "A"), m("b", "B edited", "char"), m("c", "C")]);
        const patch = diffChat(base, chatBaseline(token(2), after), none);
        expect(patch).toEqual({
            messages: [{ after: "a", message: m("b", "B edited", "char") }],
            count: 3,
        });
        expect(patch).not.toHaveProperty("meta");
        expect(patch).not.toHaveProperty("removed");
    });

    it("carries inserted messages at the start (after null), in the middle, and at the end, in stored order", () => {
        const after = chat([m("s", "S"), m("a", "A"), m("x", "X"), m("b", "B", "char"), m("c", "C"), m("e", "E")]);
        const patch = diffChat(base, chatBaseline(token(2), after), none);
        expect(ids(patch)).toEqual([
            ["s", null],
            ["x", "a"],
            ["e", "c"],
        ]);
        expect(patch!.count).toBe(6);
    });

    it("names the removed ids, and anchors the message after a removed one on its surviving predecessor", () => {
        const after = chat([m("a", "A"), m("c", "C edited")]);
        const patch = diffChat(base, chatBaseline(token(2), after), none);
        expect(patch).toEqual({ removed: ["b"], messages: [{ after: "a", message: m("c", "C edited") }], count: 2 });
    });

    it("carries the meta only when it changed, as the chat's fields without the messages", () => {
        const same = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), same), none)).toEqual({ count: 3 });
        const renamed = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")], { name: "Renamed", note: "n" });
        const patch = diffChat(base, chatBaseline(token(2), renamed), none);
        expect(patch).toEqual({ meta: { id: "k", name: "Renamed", note: "n", localLore: [] }, count: 3 });
    });

    it("always carries the rows of the messages the job began a generation on, changed or not, and only those still stored", () => {
        const generated = new Set(["b", "gone"]);
        expect(diffChat(base, chatBaseline(token(1), before), generated)).toEqual({
            messages: [{ after: "a", message: m("b", "B", "char") }],
            count: 3,
        });
        // A generated message removed meanwhile is in `removed`, not in `messages`.
        const after = chat([m("a", "A"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), after), new Set(["b"]))).toEqual({
            removed: ["b"],
            count: 2,
        });
    });

    it("gives up (the chat goes whole) when the surviving messages changed their relative order", () => {
        const reordered = chat([m("b", "B", "char"), m("a", "A"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), reordered), none)).toBeNull();
        // A reorder among survivors with insertions and removals around it is still a reorder.
        const mixed = chat([m("n", "N"), m("c", "C"), m("a", "A")]);
        expect(diffChat(base, chatBaseline(token(2), mixed), none)).toBeNull();
    });

    it("gives up for another incarnation or epoch, an older revision, and a missing or repeated id", () => {
        const after = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2, 2), after), none)).toBeNull();
        expect(
            diffChat(base, chatBaseline(token(2, 1, "22222222-2222-4333-8444-555555555555"), after), none),
        ).toBeNull();
        expect(diffChat(base, chatBaseline(token(0), after), none)).toBeNull();
        const missing = chat([m("a", "A"), { role: "user", data: "no id" } as never, m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), missing), none)).toBeNull();
        const repeated = chat([m("a", "A"), m("a", "A again"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(2), repeated), none)).toBeNull();
    });

    it("expresses the state at the later revision, not the path: a change reverted before the diff is not a change", () => {
        // Edited at revision 2 and restored at revision 3: the 1 -> 3 patch carries nothing of it.
        const restored = chat([m("a", "A"), m("b", "B", "char"), m("c", "C")]);
        expect(diffChat(base, chatBaseline(token(3), restored), none)).toEqual({ count: 3 });
    });
});
