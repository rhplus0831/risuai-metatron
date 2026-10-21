import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DetachedWrapperError,
    applyRawCharacter,
    batchRecordWrites,
    characterData,
    characterFieldStamp,
    initializeRecords,
    insertCharacterRecord,
    moveRecordListItem,
    patchRawCharacter,
    removeCharacterRecords,
    replaceCharacterRecordAt,
    replaceRecordList,
    resetRecords,
    setCharacterWriteListener,
    setRecordWriteListener,
    trackedCharacters,
    wrapperFieldStamp,
} from "../records.svelte";

// The save loop's field-text stamps (`characterFieldStamp`, `docs/structure/persistence.md` save step 2),
// checked on the records module alone: a write through a wrapper under a top-level field changes that
// field's stamp and no other, on every write path (set, delete, defineProperty, each array mutator,
// `replaceRecordList`, `moveRecordListItem`, batched writes); the raw paths change them too
// (`patchRawCharacter` even for the same identity, `applyRawCharacter`, an insertion, a new id at an
// index, a deletion and re-creation); plain JSON written into a character is copied, so the caller's
// object is not linked; a character comes to have null stamps (uncacheable) when it shares state
// between fields or holds data that is not plain JSON, and not for the ordinary same-field reuses; and
// the alias and wrapper cases: the sort comparator alias, `reloadKeys` and symbol
// properties holding record state, the retained wrapper of a `defineProperty`-installed container
// across a mutator's write-back, and a failed preparation leaving no taint.

const list = () => trackedCharacters<any[]>()!;
const byId = (chaId: string) => list().find((entry: any) => entry.chaId === chaId);
const raw = (chaId: string) => characterData().find((entry) => entry.chaId === chaId) as any;
const text = () => JSON.stringify(characterData());
const stamp = (chaId: string, field: string) => characterFieldStamp(chaId, field);
const define = (target: object, key: string | symbol, value: unknown) =>
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
/** The stamps of every own field of a character. */
const stamps = (chaId: string): Record<string, number | null> =>
    Object.fromEntries(Object.keys(raw(chaId)).map((field) => [field, stamp(chaId, field)]));
const cacheable = (chaId: string) => Object.values(stamps(chaId)).every((value) => typeof value === "number");

/** Runs `write` and returns the fields whose stamp changed. */
function changed(chaId: string, write: () => void): string[] {
    const before = stamps(chaId);
    write();
    const after = stamps(chaId);
    return Object.keys({ ...before, ...after }).filter((field) => before[field] !== after[field]);
}

beforeEach(() => {
    resetRecords();
    setRecordWriteListener(() => {});
    setCharacterWriteListener({ character: () => {}, membership: () => {} });
});
afterEach(() => resetRecords());

describe("a write under a top-level field stamps that field only", () => {
    it("set at any depth, delete, defineProperty, a batched write, a length write", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", lore: [{ x: 1 }], meta: { k: { v: 1 } } }] });
        const a = byId("a");
        expect(typeof stamp("a", "name")).toBe("number");
        expect(stamp("a", "name")).toBe(stamp("a", "lore"));
        expect(changed("a", () => (a.lore[0].x = 2))).toEqual(["lore"]);
        expect(changed("a", () => (a.meta.k.v = 2))).toEqual(["meta"]);
        expect(changed("a", () => (a.name = "B"))).toEqual(["name"]);
        expect(changed("a", () => (a.extra = { n: 1 }))).toEqual(["extra"]);
        expect(changed("a", () => define(a, "defined", [1]))).toEqual(["defined"]);
        expect(changed("a", () => define(a.defined, "0", 2))).toEqual(["defined"]);
        expect(changed("a", () => delete a.meta.k)).toEqual(["meta"]);
        expect(changed("a", () => delete a.extra)).toEqual(["extra"]);
        expect(changed("a", () => (a.lore.length = 0))).toEqual(["lore"]);
        // Stamped at write time, not when the batch ends.
        const before = stamp("a", "name");
        batchRecordWrites(() => {
            a.name = "C";
            expect(stamp("a", "name")).not.toBe(before);
        });
        expect(stamp("a", "lore")).not.toBe(stamp("a", "name"));
    });

    it("every array mutator, replaceRecordList, and moveRecordListItem", () => {
        initializeRecords({
            characters: [{ chaId: "a", name: "A", rows: [{ n: 3 }, { n: 1 }, { n: 2 }], other: [{ m: 1 }] }],
        });
        const a = byId("a");
        expect(changed("a", () => a.rows.push({ n: 4 }))).toEqual(["rows"]);
        expect(changed("a", () => a.rows.pop())).toEqual(["rows"]);
        expect(changed("a", () => a.rows.unshift({ n: 0 }))).toEqual(["rows"]);
        expect(changed("a", () => a.rows.shift())).toEqual(["rows"]);
        expect(changed("a", () => a.rows.splice(1, 1, { n: 9 }))).toEqual(["rows"]);
        expect(changed("a", () => a.rows.sort((x: any, y: any) => x.n - y.n))).toEqual(["rows"]);
        expect(changed("a", () => a.rows.reverse())).toEqual(["rows"]);
        expect(changed("a", () => a.rows.copyWithin(0, 1, 2))).toEqual(["rows"]);
        expect(changed("a", () => a.rows.fill({ n: 7 }, 2))).toEqual(["rows"]);
        expect(changed("a", () => replaceRecordList(a.rows, [a.rows[1], a.rows[0]]))).toEqual(["rows"]);
        expect(changed("a", () => moveRecordListItem(a.rows, 0, 1))).toEqual(["rows"]);
        expect(cacheable("a")).toBe(true);
        expect(raw("a").other).toEqual([{ m: 1 }]);
    });
});

describe("the raw paths", () => {
    it("patchRawCharacter stamps the named fields, even for the value already held", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", lore: [{ x: 1 }] }] });
        const held = raw("a").lore;
        expect(changed("a", () => patchRawCharacter("a", [["lore", held]]))).toEqual(["lore"]);
        expect(changed("a", () => patchRawCharacter("a", [["lastInteraction", 5]]))).toEqual(["lastInteraction"]);
        expect(raw("a").lore).toBe(held);
    });

    it("applyRawCharacter, an insertion, a new id at an index, and a re-creation change every stamp, written or not", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", lore: [] }] });
        byId("a").name = "B";
        let before = stamps("a");
        applyRawCharacter("a", { chaId: "a", name: "C", lore: [] });
        expect(changed("a", () => {})).toEqual([]);
        let after = stamps("a");
        expect(Object.keys(after).every((field) => after[field] !== before[field])).toBe(true);

        before = stamps("a");
        insertCharacterRecord({ chaId: "b", name: "B", lore: [] });
        expect(stamp("b", "name")).not.toBe(before.name);
        expect(stamp("b", "lore")).toBe(stamp("b", "name"));
        expect(stamps("a")).toEqual(before);

        // The same id replaced: a field kept by its wrapper keeps its identity and stamp, the rest are new values.
        const lore = raw("a").lore;
        before = stamps("a");
        replaceCharacterRecordAt(0, { chaId: "a", name: "D", lore: byId("a").lore });
        expect(raw("a").lore).toBe(lore);
        expect(stamp("a", "lore")).toBe(before.lore);
        expect(raw("a").name).toBe("D");

        // Another id at the index: a fresh lifetime for it.
        const bBefore = stamps("b");
        removeCharacterRecords(["b"]);
        replaceCharacterRecordAt(0, { chaId: "b", name: "B2", lore: [] });
        after = stamps("b");
        expect(Object.keys(after).every((field) => after[field] !== bBefore[field])).toBe(true);

        // Deleted and created again with the same id: a new record, no stamp of the old one.
        before = stamps("b");
        removeCharacterRecords(["b"]);
        insertCharacterRecord({ chaId: "b", name: "B3", lore: [] });
        after = stamps("b");
        expect(Object.keys(after).every((field) => after[field] !== before[field])).toBe(true);
        expect(cacheable("b")).toBe(true);
    });
});

describe("plain JSON written into a character is copied", () => {
    it("the caller's object and array are not linked to the record (an assignment, a push, an insertion)", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", rows: [] }] });
        const a = byId("a");
        const input = { n: 1, nested: { d: 1 } };
        a.payload = input;
        input.n = 2;
        input.nested.d = 2;
        (input as any).added = true;
        expect(raw("a").payload).toEqual({ n: 1, nested: { d: 1 } });
        const arr = [{ n: 1 }];
        a.rows = arr;
        arr.push({ n: 2 });
        arr[0].n = 9;
        expect(raw("a").rows).toEqual([{ n: 1 }]);
        const pushed = { n: 5 };
        a.rows.push(pushed);
        pushed.n = 6;
        expect(raw("a").rows).toEqual([{ n: 1 }, { n: 5 }]);
        const whole = { chaId: "b", name: "B", rows: [{ n: 1 }] };
        insertCharacterRecord(whole);
        whole.rows[0].n = 7;
        expect(raw("b").rows).toEqual([{ n: 1 }]);
        // An own `__proto__` key and a sparse array survive the copy as JSON.stringify sees them.
        a.map = JSON.parse('{"__proto__":1,"k":2}');
        expect(JSON.stringify(raw("a").map)).toBe('{"__proto__":1,"k":2}');
        const sparse = [1];
        sparse[2] = 3;
        a.sparse = sparse;
        expect(JSON.stringify(raw("a").sparse)).toBe("[1,null,3]");
        expect(cacheable("a")).toBe(true);
        expect(cacheable("b")).toBe(true);
    });

    it("a value of another character is a copy and a write to it does not reach the source", () => {
        initializeRecords({
            characters: [
                { chaId: "a", name: "A", rows: [{ n: 1 }] },
                { chaId: "b", name: "B", rows: [] },
            ],
        });
        byId("b").rows = byId("a").rows;
        byId("b").rows[0].n = 2;
        byId("b").rows.push(byId("a").rows[0]);
        expect(raw("a").rows).toEqual([{ n: 1 }]);
        expect(raw("b").rows).toEqual([{ n: 2 }, { n: 1 }]);
        expect(cacheable("a")).toBe(true);
        expect(cacheable("b")).toBe(true);
    });
});

describe("null stamps (uncacheable)", () => {
    it("state shared between two fields: an assignment, a mutator insertion, a nested wrapper, a sort comparator writing a raw object", () => {
        const fixture = () => ({
            chaId: "a",
            name: "A",
            left: { n: 1 },
            right: { n: 1 },
            rows: [2, 1],
            other: [{ m: 1 }],
        });
        initializeRecords({ characters: [fixture()] });
        let a = byId("a");
        a.right = a.left;
        expect(stamp("a", "name")).toBeNull();
        expect(stamp("a", "left")).toBeNull();
        // Sticky until the data is fresh again.
        a.name = "B";
        expect(stamp("a", "name")).toBeNull();
        applyRawCharacter("a", fixture());
        expect(cacheable("a")).toBe(true);

        a = byId("a");
        a.rows.push(a.other[0]);
        expect(cacheable("a")).toBe(false);
        applyRawCharacter("a", fixture());

        a = byId("a");
        a.left = { inner: a.other };
        expect(cacheable("a")).toBe(false);
        applyRawCharacter("a", fixture());

        // A comparator writing a raw owned object (read through `characterData`)
        // into another field during a sort must mark the alias.
        a = byId("a");
        void a.left;
        const rawLeft = raw("a").left;
        a.rows.sort((x: number, y: number) => {
            a.right = rawLeft;
            return x - y;
        });
        expect(raw("a").rows).toEqual([1, 2]);
        expect(raw("a").right).toBe(rawLeft);
        expect(cacheable("a")).toBe(false);
    });

    it("data that is not plain JSON: a function, a toJSON hook, an accessor, a class instance, a null-prototype object, a cycle", () => {
        const fixture = () => ({ chaId: "a", name: "A", rows: [1] });
        const cases: ((a: any) => void)[] = [
            (a) => (a.fn = () => 1),
            (a) => (a.hooked = { toJSON: () => 1 }),
            (a) => (a.deep = { inner: [{ toJSON: () => 1 }] }),
            (a) => (a.accessor = Object.defineProperty({}, "g", { get: () => 1, enumerable: true })),
            (a) => (a.when = new Date(0)),
            (a) => (a.bare = Object.assign(Object.create(null), { n: 1 })),
            (a) => {
                const cycle: any = { n: 1 };
                cycle.self = cycle;
                a.cycle = cycle;
            },
            (a) => a.rows.push(() => 1),
            (a) => a.rows.push(new Date(0)),
            (a) => define(a, "defined", { toJSON: () => 1 }),
        ];
        for (const write of cases) {
            initializeRecords({ characters: [fixture()] });
            expect(cacheable("a")).toBe(true);
            write(byId("a"));
            expect(cacheable("a"), write.toString()).toBe(false);
        }
    });

    it("not for the ordinary same-field reuses or a settings-style rebuild", () => {
        initializeRecords({
            characters: [{ chaId: "a", name: "A", rows: [{ n: 1 }, { n: 2 }], lore: { entries: [{ x: 1 }], k: 1 } }],
        });
        const a = byId("a");
        a.rows.push(a.rows[0]);
        a.rows.splice(0, 1, a.rows[1]);
        a.rows = [...a.rows].reverse();
        a.rows.sort((x: any, y: any) => x.n - y.n);
        a.rows.unshift({ n: 0 });
        a.lore = { ...a.lore, k: 2 };
        a.lore.entries = a.lore.entries.filter(() => true);
        replaceRecordList(a.rows, [a.rows[2], a.rows[1], a.rows[0]]);
        a.rows.fill(a.rows[0], 1, 2);
        expect(cacheable("a")).toBe(true);
        expect(raw("a").lore).toEqual({ entries: [{ x: 1 }], k: 2 });
        expect(raw("a").rows.map((row: any) => row.n)).toEqual([2, 2, 0]);
    });
});

describe("retained wrappers and failed preparations", () => {
    it("a retained wrapper of a defineProperty-installed (unproxied) container survives a splice re-insertion and a same-task displaced push", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A" }] });
        const a = byId("a");
        define(a, "rows", [{ n: 1 }, { n: 2 }]);
        const held = a.rows[0];
        a.rows.splice(0, 1, held);
        held.n = 9;
        expect(raw("a").rows).toEqual([{ n: 9 }, { n: 2 }]);
        replaceRecordList(a.rows, [a.rows[1]]);
        a.rows.push(held);
        held.n = 5;
        expect(raw("a").rows).toEqual([{ n: 2 }, { n: 5 }]);
        // The same on an assigned (proxied) array and on an installed one.
        a.more = [{ n: 1 }, { n: 2 }];
        const kept = a.more[0];
        a.more.splice(0, 1, kept);
        kept.n = 9;
        replaceRecordList(a.more, [a.more[1]]);
        a.more.push(kept);
        kept.n = 5;
        expect(raw("a").more).toEqual([{ n: 2 }, { n: 5 }]);
        expect(cacheable("a")).toBe(true);
    });

    it("a failed preparation leaves the data and the stamps as they were", async () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", rows: [{ n: 1 }, { n: 2 }], other: { m: 1 } }] });
        const a = byId("a");
        const removed = a.rows[0];
        a.rows.splice(0, 1);
        // The displacement bookkeeping clears at the end of the task.
        await tick();
        await Promise.resolve();
        const before = text();
        const stampsBefore = stamps("a");
        expect(() => a.rows.push(a.other, removed)).toThrow(DetachedWrapperError);
        expect(text()).toBe(before);
        expect(stamps("a")).toEqual(stampsBefore);
        expect(cacheable("a")).toBe(true);
    });

    it("a local field (reloadKeys) holding record state at any depth gets a detached copy", () => {
        initializeRecords({
            characters: [
                { chaId: "a", name: "A", payload: { n: 1 } },
                { chaId: "b", name: "B" },
            ],
        });
        const a = byId("a");
        const b = byId("b");
        void a.payload;
        const rawPayload = raw("a").payload;
        a.reloadKeys = { nested: rawPayload, w: a.payload, plain: 1 };
        a.reloadKeys.nested.n = 7;
        a.reloadKeys.w.n = 8;
        expect(raw("a").payload).toEqual({ n: 1 });
        expect(raw("a").reloadKeys.plain).toBe(1);
        expect(raw("a").reloadKeys.nested.n).toBe(7);
        expect(raw("a").reloadKeys.w.n).toBe(8);
        // Across characters too, and through the insertion path.
        b.reloadKeys = { nested: rawPayload };
        b.reloadKeys.nested.n = 9;
        insertCharacterRecord({ chaId: "c", name: "C", reloadKeys: { deep: [rawPayload] } });
        raw("c").reloadKeys.deep[0].n = 10;
        expect(raw("a").payload).toEqual({ n: 1 });
        // A plain key stays raw (the render key's ordinary use).
        a.reloadKeys = 3;
        expect(raw("a").reloadKeys).toBe(3);
        expect(cacheable("a")).toBe(true);
        expect(cacheable("b")).toBe(true);
    });

    it("a symbol property is adopted like a field: plain data copied, the character's own state marks it", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", payload: { n: 1 } }] });
        const a = byId("a");
        const key = Symbol("alias");
        const input = { n: 1 };
        a[key] = input;
        input.n = 2;
        a[key].n = 3;
        expect(input.n).toBe(2);
        expect(JSON.stringify(raw("a"))).not.toContain("3");
        expect(cacheable("a")).toBe(true);
        void a.payload;
        a[key] = raw("a").payload;
        a[key].n = 6;
        expect(raw("a").payload).toEqual({ n: 6 });
        expect(cacheable("a")).toBe(false);
    });
});

// `wrapperFieldStamp`: the parser's fuzzy asset lookup reuses an interim index of a character's asset
// list only while the list wrapper's stamp is unchanged (`fuzzyIndexOf`), so every change the wrapper
// can read must change it, a same-id whole replacement included. A valid asset
// field is a frozen leaf (no wrapper, `characterAssetLists.test.ts`), so the
// generic wrapper behavior is checked on a mutable field of tuples (`rows`) here.
describe("wrapperFieldStamp", () => {
    const assetsOf = (chaId: string) => byId(chaId).rows;

    beforeEach(() => {
        initializeRecords({
            characters: [{ chaId: "a", name: "A", rows: [["old", "old.png", "png"]], other: { n: 1 } }],
        });
    });

    it("is the character field's stamp for a wrapper under the field", () => {
        const assets = assetsOf("a");
        expect(wrapperFieldStamp(assets)).toBe(stamp("a", "rows"));
        expect(wrapperFieldStamp(assets[0])).toBe(stamp("a", "rows"));
    });

    it("changes at every write the list can read and not at a write elsewhere", () => {
        const assets = assetsOf("a");
        const seen = new Set([wrapperFieldStamp(assets)]);
        const writes = [
            () => (assets[0][0] = "renamed"),
            () => (assets[0][1] = "other.png"),
            () => (assets[0][2] = "webm"),
            () => assets.push(["more", "more.png", "png"]),
            () => assets.reverse(),
            () => assets.splice(0, 1),
            () => patchRawCharacter("a", [["rows", [["raw", "raw.png", "png"]]]]),
        ];
        for (const write of writes) {
            write();
            const next = wrapperFieldStamp(assetsOf("a"));
            expect(next).not.toBeNull();
            expect(seen.has(next)).toBe(false);
            seen.add(next);
        }
        const before = wrapperFieldStamp(assetsOf("a"));
        byId("a").name = "B";
        byId("a").other.n = 2;
        expect(wrapperFieldStamp(assetsOf("a"))).toBe(before);
    });

    it("changes for a retained wrapper when the character is replaced whole under the same id", () => {
        const assets = assetsOf("a");
        const before = wrapperFieldStamp(assets);
        const otherBefore = stamp("a", "other");
        // Its own state (read through the wrapper) is kept, not copied; a plain object would be.
        const other = byId("a").other;
        replaceCharacterRecordAt(0, { chaId: "a", rows: [["new", "new.webm", "webm"]], other } as any);
        expect(JSON.parse(JSON.stringify(assets))).toEqual([["new", "new.webm", "webm"]]);
        expect(wrapperFieldStamp(assets)).not.toBe(before);
        expect(wrapperFieldStamp(assets)).not.toBeNull();
        // A field whose value keeps its identity keeps its stamp; a removed one changes.
        expect(stamp("a", "other")).toBe(otherBefore);
        expect(changed("a", () => replaceCharacterRecordAt(0, { chaId: "a", other } as any))).toContain("rows");
    });

    it("changes when the character's data is fresh from the server", () => {
        const assets = assetsOf("a");
        const before = wrapperFieldStamp(assets);
        applyRawCharacter("a", { chaId: "a", name: "A", rows: [["old", "old.png", "png"]] });
        expect(wrapperFieldStamp(assetsOf("a"))).not.toBe(before);
    });

    it("is null for anything but a live character field wrapper, a frozen asset list, and for an uncacheable character", () => {
        expect(wrapperFieldStamp([["old", "old.png", "png"]])).toBeNull();
        expect(wrapperFieldStamp(null)).toBeNull();
        expect(wrapperFieldStamp(byId("a"))).toBeNull();
        // A valid asset field reads as the frozen list itself: no wrapper, no stamp.
        byId("a").additionalAssets = [["frozen", "frozen.png", "png"]];
        expect(wrapperFieldStamp(byId("a").additionalAssets)).toBeNull();
        expect(wrapperFieldStamp(byId("a").additionalAssets[0])).toBeNull();
        const assets = assetsOf("a");
        byId("a").copy = raw("a").rows;
        expect(stamp("a", "rows")).toBeNull();
        expect(wrapperFieldStamp(assets)).toBeNull();
        resetRecords();
        expect(wrapperFieldStamp(assets)).toBeNull();
    });
});
