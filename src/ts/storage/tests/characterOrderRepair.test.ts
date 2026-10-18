import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Data-loss plan slice 7b: the add-only order repair (`queueRemoteCharOrderRepair`,
// `characterOrder.ts`) over stubbed stores and a controlled `readRefs`, for what the adapter
// fixtures cannot drive: the read chunking under the server's 5,000-entry cap, invalidation and
// failure in a later chunk, failure coalescing, and the per-candidate eligibility rule. The
// integration cases are in `resourceSyncLive.test.ts` and `resourceSync.test.ts` ("conflicts").

const { client, stores } = vi.hoisted(() => {
    const stores = {
        characters: [] as { chaId: string; trashTime?: number }[],
        order: [] as unknown[],
        /** Every assignment of `settings.characterOrder`, as assigned. */
        assignments: [] as unknown[],
    };
    const settings = {} as { characterOrder: unknown[] };
    Object.defineProperty(settings, "characterOrder", {
        get: () => stores.order,
        set: (value: unknown[]) => {
            stores.assignments.push(JSON.parse(JSON.stringify(value)));
            stores.order = value;
        },
    });
    return { client: { readRefs: vi.fn() }, stores: Object.assign(stores, { settings }) };
});

vi.mock("../resourceClient", () => ({ readRefs: (...args: unknown[]) => client.readRefs(...args) }));
vi.mock("../characterStore.svelte", () => ({ characterList: () => stores.characters }));
vi.mock("../settingsViews.svelte", () => ({ settings: stores.settings }));

type Ref = { kind: string; id: string };
type Item = { kind: string; id: string; revision: string | null; data: unknown };
type Pending = { refs: Ref[]; resolve: (items: Item[]) => void; reject: (error: unknown) => void };

const live = (id: string): Item => ({ kind: "characters", id, revision: "r1", data: { chaId: id } });
const trashed = (id: string): Item => ({ kind: "characters", id, revision: "r1", data: { chaId: id, trashTime: 1 } });
const absent = (id: string): Item => ({ kind: "characters", id, revision: null, data: null });

/** `readRefs` as a queue of unanswered reads the test answers one by one. */
function pendingReads(): Pending[] {
    const pending: Pending[] = [];
    client.readRefs.mockImplementation(
        (refs: Ref[]) =>
            new Promise<{ items: Item[] }>((resolve, reject) =>
                pending.push({ refs, resolve: (items) => resolve({ items }), reject }),
            ),
    );
    return pending;
}
const answer = (read: Pending, by: (id: string) => Item = live) => read.resolve(read.refs.map((ref) => by(ref.id)));
const awaitReads = (pending: Pending[], count: number) => vi.waitFor(() => expect(pending).toHaveLength(count));
/** Lets a repair that reads nothing (or ends without a read) run to its end. */
const drain = async () => {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
};
const ids = (count: number, prefix = "x") => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

async function load(options: { characters?: string[]; order?: unknown[]; held?: Record<string, string | null> } = {}) {
    vi.resetModules();
    stores.characters = (options.characters ?? ["d"]).map((chaId) => ({ chaId }));
    stores.order = options.order ?? ["c"];
    stores.assignments = [];
    const held = new Map(Object.entries(options.held ?? {}));
    const module = await import("../characterOrder");
    /** The saved revision of a character: "r1" unless the case says otherwise (`null`: an unsaved create). */
    const heldRevision = (chaId: string) => (held.has(chaId) ? held.get(chaId)! : "r1");
    return {
        queue: () => module.queueRemoteCharOrderRepair(heldRevision),
        held,
        plain: () => JSON.parse(JSON.stringify(stores.order)),
    };
}

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    client.readRefs.mockReset();
});

describe("queueRemoteCharOrderRepair", () => {
    it("reads nothing and writes nothing when every live character is ordered", async () => {
        const { queue } = await load({ characters: ["c", "p", "§playground"], order: ["c", { id: "f", data: ["p"] }] });
        pendingReads();
        queue();
        await drain();
        expect(client.readRefs).not.toHaveBeenCalled();
        expect(stores.assignments).toEqual([]);
    });

    it("appends an unsaved create the server lacks and a live server copy; neither a saved character the server lost, a server-trashed one, nor a locally trashed one", async () => {
        const { queue, plain } = await load({
            characters: ["unsaved", "lost", "trashedThere", "liveThere", "trashedHere", "§playground"],
            held: { unsaved: null },
        });
        stores.characters.find((entry) => entry.chaId === "trashedHere")!.trashTime = 1;
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        expect(pending[0].refs).toEqual(
            ["unsaved", "lost", "trashedThere", "liveThere"].map((id) => ({ kind: "characters", id })),
        );
        answer(pending[0], (id) =>
            ({ unsaved: absent, lost: absent, trashedThere: trashed, liveThere: live })[id]!(id),
        );
        await vi.waitFor(() => expect(stores.assignments).toHaveLength(1));
        expect(plain()).toEqual(["c", "unsaved", "liveThere"]);
        await drain();
        expect(client.readRefs).toHaveBeenCalledTimes(1);
    });

    it("judges an absent answer by the revision held before the read: a create acknowledged during its read stays eligible", async () => {
        const { queue, held, plain } = await load({ characters: ["n"], held: { n: null } });
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        held.set("n", "r2");
        answer(pending[0], absent);
        await vi.waitFor(() => expect(plain()).toEqual(["c", "n"]));
        expect(stores.assignments).toHaveLength(1);
    });

    it("does not append a character trashed here while its read was out", async () => {
        const { queue, plain } = await load();
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        stores.characters[0].trashTime = 1;
        answer(pending[0]);
        await drain();
        expect(stores.assignments).toEqual([]);
        expect(plain()).toEqual(["c"]);
        expect(client.readRefs).toHaveBeenCalledTimes(1);
    });

    it("reads the candidates in chunks of at most 1,000 refs and assigns the order once, with every confirmed character appended", async () => {
        const all = ids(5001);
        const { queue, plain } = await load({ characters: ["c", ...all] });
        const pending = pendingReads();
        queue();
        for (let chunk = 0; chunk < 6; chunk++) {
            await awaitReads(pending, chunk + 1);
            expect(pending[chunk].refs.length).toBe(chunk < 5 ? 1000 : 1);
            expect(pending[chunk].refs.map((ref) => ref.id)).toEqual(all.slice(chunk * 1000, chunk * 1000 + 1000));
            expect(stores.assignments).toEqual([]);
            answer(pending[chunk]);
        }
        await vi.waitFor(() => expect(stores.assignments).toHaveLength(1));
        expect(plain()).toEqual(["c", ...all]);
        await drain();
        expect(client.readRefs).toHaveBeenCalledTimes(6);
    });

    it("drops a read answered after a newer order was announced, even one of the same text, and reads again from the newest order without an intermediate write", async () => {
        const { queue, plain } = await load();
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        queue();
        answer(pending[0]);
        await awaitReads(pending, 2);
        expect(stores.assignments).toEqual([]);
        expect(pending[1].refs).toEqual([{ kind: "characters", id: "d" }]);
        answer(pending[1], trashed);
        await drain();
        expect(stores.assignments).toEqual([]);
        expect(plain()).toEqual(["c"]);
        expect(client.readRefs).toHaveBeenCalledTimes(2);
        // The loop ended: the next announcement starts a new one.
        queue();
        await awaitReads(pending, 3);
        answer(pending[2]);
        await vi.waitFor(() => expect(plain()).toEqual(["c", "d"]));
    });

    it("drops a read answered after the order changed here, keeps that edit, and appends to it from a fresh read", async () => {
        const { queue, plain } = await load();
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        const folder = { id: "g", name: "G", data: ["c"] };
        stores.settings.characterOrder = [folder];
        answer(pending[0]);
        await awaitReads(pending, 2);
        expect(stores.assignments).toEqual([[folder]]);
        answer(pending[1]);
        await vi.waitFor(() => expect(stores.assignments).toHaveLength(2));
        expect(plain()).toEqual([folder, "d"]);
    });

    it("discards the earlier chunks when a newer order arrives during a later one: nothing appended from them, the read starts over", async () => {
        const all = ids(1500);
        const { queue, plain } = await load({ characters: all });
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        answer(pending[0]);
        await awaitReads(pending, 2);
        queue();
        answer(pending[1]);
        await awaitReads(pending, 3);
        expect(stores.assignments).toEqual([]);
        expect(pending[2].refs.map((ref) => ref.id)).toEqual(all.slice(0, 1000));
        answer(pending[2]);
        await awaitReads(pending, 4);
        answer(pending[3]);
        await vi.waitFor(() => expect(stores.assignments).toHaveLength(1));
        expect(plain()).toEqual(["c", ...all]);
    });

    it("ends on a failed read without a partial write (logged), and repairs again at the next announcement", async () => {
        const all = ids(1500);
        const { queue, plain } = await load({ characters: all });
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        answer(pending[0]);
        await awaitReads(pending, 2);
        pending[1].reject(new Error("read failed"));
        await drain();
        expect(stores.assignments).toEqual([]);
        expect(client.readRefs).toHaveBeenCalledTimes(2);
        expect(console.error).toHaveBeenCalledWith("[Save]", expect.objectContaining({ message: "read failed" }));
        queue();
        await awaitReads(pending, 3);
        answer(pending[2]);
        await awaitReads(pending, 4);
        answer(pending[3]);
        await vi.waitFor(() => expect(stores.assignments).toHaveLength(1));
        expect(plain()).toEqual(["c", ...all]);
    });

    it("does not let a failed read swallow a newer order announced during it", async () => {
        const { queue, plain } = await load();
        const pending = pendingReads();
        queue();
        await awaitReads(pending, 1);
        queue();
        pending[0].reject(new Error("read failed"));
        await awaitReads(pending, 2);
        answer(pending[1]);
        await vi.waitFor(() => expect(plain()).toEqual(["c", "d"]));
        expect(stores.assignments).toHaveLength(1);
    });

    it("coalesces announcements made while a repair runs into one loop that ends once the order is quiet", async () => {
        const { queue, plain } = await load();
        const pending = pendingReads();
        queue();
        queue();
        queue();
        await awaitReads(pending, 1);
        answer(pending[0]);
        await vi.waitFor(() => expect(plain()).toEqual(["c", "d"]));
        await drain();
        expect(client.readRefs).toHaveBeenCalledTimes(1);
        expect(stores.assignments).toHaveLength(1);
    });
});
