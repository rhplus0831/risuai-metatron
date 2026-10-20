import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    DetachedWrapperError,
    applyRawCharacter,
    characterData,
    characterFieldPlain,
    characterFieldStamp,
    initializeRecords,
    insertCharacterRecord,
    isFrozenAssetList,
    isRecordWrapper,
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

// A character's asset lists as immutable values (heap plan B2, `docs/structure/persistence.md`):
// `additionalAssets` and `emotionImages` (tuples) and `ccAssets` (flat records) are frozen when
// they enter the record through the raw paths, and a whole field written or stored becomes a wholly
// owned frozen copy that shares only verified entries. Covered on the records module alone: the
// three install paths; reads returning the frozen value (never a wrapper); every refused in-place
// write leaving text, stamps and notifications unchanged; ownership (same-character unproxied
// containers, nested aliases, own `$state` edits, foreign state); the mutable fallback for every
// unsupported shape, with the JSON the ordinary adoption stores (the challenge's holes, class
// instance, accessor and out-of-range key reproductions, Sol 2026-10-19); retained wrappers of a
// mutable list that later resolves to a frozen one (the Proxy invariants, `isFrozenAssetList`
// false, the stamp following); a retained frozen value staying the old value; `characterFieldPlain`
// and the stored-character paths; and local/ordinary fields staying as they were.

type Tuple = [string, string, string];
const list = () => trackedCharacters<any[]>()!;
const byId = (chaId: string) => list().find((entry: any) => entry.chaId === chaId);
const raw = (chaId: string) => characterData().find((entry) => entry.chaId === chaId) as any;
const text = () => JSON.stringify(characterData());
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const stamp = (chaId: string, field: string) => characterFieldStamp(chaId, field);
const define = (target: object, key: string | symbol, value: unknown) =>
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
const stamps = (chaId: string): Record<string, number | null> =>
    Object.fromEntries(Object.keys(raw(chaId)).map((field) => [field, stamp(chaId, field)]));
const cacheable = (chaId: string) => Object.values(stamps(chaId)).every((value) => typeof value === "number");
const tuple = (name: string): Tuple => [name, `assets/${name}.png`, "png"];
const icon = (name: string) => ({ type: "icon", uri: `icons/${name}.png`, name, ext: "png" });
const fixture = () => ({
    chaId: "a",
    name: "A",
    additionalAssets: [tuple("one"), tuple("two")],
    emotionImages: [
        ["joy", "emotions/joy.png"],
        ["calm", "emotions/calm.png"],
    ],
    ccAssets: [icon("first"), icon("second")],
    rows: [tuple("row")],
});
const FIELDS = ["additionalAssets", "emotionImages", "ccAssets"] as const;

const characterWrites = vi.fn();
beforeEach(() => {
    resetRecords();
    setRecordWriteListener(() => {});
    characterWrites.mockClear();
    setCharacterWriteListener({ character: characterWrites, membership: () => {} });
});
afterEach(() => resetRecords());

/** Runs `write` and returns what it changed: the character text, the stamps, and the write notifications. */
function effects(chaId: string, write: () => void) {
    const before = { text: text(), stamps: stamps(chaId), writes: characterWrites.mock.calls.length };
    write();
    return {
        text: text() !== before.text,
        stamps: Object.keys(stamps(chaId)).filter((field) => stamps(chaId)[field] !== before.stamps[field]),
        writes: characterWrites.mock.calls.length - before.writes,
    };
}

describe("installation", () => {
    it("initializeRecords freezes the three fields, entries then list, and a read returns the frozen value, never a wrapper", () => {
        const input = fixture();
        initializeRecords({ characters: [input] });
        const a = byId("a");
        for (const field of FIELDS) {
            // Handed over: frozen in place.
            expect(Object.isFrozen(input[field]), field).toBe(true);
            expect(Object.isFrozen(input[field][0]), field).toBe(true);
            const value = a[field];
            expect(isRecordWrapper(value), field).toBe(false);
            expect(isFrozenAssetList(value), field).toBe(true);
            expect(Object.isFrozen(value), field).toBe(true);
            expect(isRecordWrapper(value[0]), field).toBe(false);
            expect(Object.isFrozen(value[0]), field).toBe(true);
            // Identity is stable across reads (the caches key by it). `characterFieldPlain` returns the
            // frozen value too; under Svelte DEV a wrapper read returns the `$state` proxy's
            // `inspectable_array` target, so the two are compared by content, not identity.
            expect(a[field], field).toBe(value);
            expect(Object.getOwnPropertyDescriptor(a, field)!.value, field).toBe(value);
            const copy = characterFieldPlain("a", field);
            expect(isFrozenAssetList(copy), field).toBe(true);
            expect(plain(copy), field).toEqual(plain(value));
            expect(characterFieldPlain("a", field), field).toBe(copy);
        }
        expect(plain(a.additionalAssets)).toEqual([tuple("one"), tuple("two")]);
        expect(plain(a.emotionImages)).toEqual([
            ["joy", "emotions/joy.png"],
            ["calm", "emotions/calm.png"],
        ]);
        expect(plain(a.ccAssets)).toEqual([icon("first"), icon("second")]);
        // A non-asset field of tuples is an ordinary mutable, wrapped field.
        expect(isRecordWrapper(a.rows)).toBe(true);
        expect(Object.isFrozen(input.rows)).toBe(false);
        expect(JSON.stringify(a)).toBe(JSON.stringify(raw("a")));
        expect(cacheable("a")).toBe(true);
    });

    it("a list of another shape stays mutable and wrapped, for each field; an empty list is frozen for both shapes", () => {
        initializeRecords({
            characters: [
                {
                    chaId: "a",
                    additionalAssets: [tuple("ok"), { not: "a tuple" }],
                    emotionImages: [["joy", { nested: true }]],
                    ccAssets: [{ type: "icon", nested: { deep: 1 } }],
                    empty: [],
                },
            ],
        });
        const a = byId("a");
        for (const field of FIELDS) {
            expect(isRecordWrapper(a[field]), field).toBe(true);
            expect(isFrozenAssetList(a[field]), field).toBe(false);
            expect(Object.isFrozen(raw("a")[field]), field).toBe(false);
        }
        a.additionalAssets[0][0] = "edited in place";
        a.ccAssets[0].type = "edited";
        expect(raw("a").additionalAssets[0][0]).toBe("edited in place");
        expect(raw("a").ccAssets[0].type).toBe("edited");
        // Empty lists qualify for both shapes: the same frozen value can serve a tuple and a record field.
        a.additionalAssets = [];
        a.ccAssets = a.additionalAssets;
        expect(isFrozenAssetList(a.ccAssets)).toBe(true);
        expect(isFrozenAssetList(a.additionalAssets)).toBe(true);
        expect(() => a.ccAssets.push(icon("x"))).toThrow(TypeError);
        expect(cacheable("a")).toBe(true);
    });

    it("applyRawCharacter and patchRawCharacter freeze the handed-over values in place and renew or stamp the field", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", additionalAssets: [] }] });
        const data = fixture();
        applyRawCharacter("a", data);
        for (const field of FIELDS) {
            expect(Object.isFrozen(data[field]), field).toBe(true);
            expect(isFrozenAssetList(byId("a")[field]), field).toBe(true);
        }
        const patched = { additionalAssets: [tuple("patched")], ccAssets: [icon("patched")], rows: [tuple("r")] };
        const before = stamps("a");
        patchRawCharacter("a", [
            ["additionalAssets", patched.additionalAssets],
            ["ccAssets", patched.ccAssets],
            ["rows", patched.rows],
        ]);
        expect(Object.isFrozen(patched.additionalAssets)).toBe(true);
        expect(Object.isFrozen(patched.additionalAssets[0])).toBe(true);
        expect(Object.isFrozen(patched.ccAssets)).toBe(true);
        expect(Object.isFrozen(patched.rows)).toBe(false);
        expect(isFrozenAssetList(byId("a").additionalAssets)).toBe(true);
        expect(isFrozenAssetList(byId("a").ccAssets)).toBe(true);
        expect(isRecordWrapper(byId("a").rows)).toBe(true);
        expect(stamp("a", "additionalAssets")).not.toBe(before.additionalAssets);
        expect(stamp("a", "ccAssets")).not.toBe(before.ccAssets);
        expect(stamp("a", "emotionImages")).toBe(before.emotionImages);
        // A patch of a shape the field does not take stays mutable; the same identity patched again stays frozen.
        const odd = [tuple("ok"), { not: "a tuple" }];
        patchRawCharacter("a", [["emotionImages", odd]]);
        expect(Object.isFrozen(odd)).toBe(false);
        expect(isRecordWrapper(byId("a").emotionImages)).toBe(true);
        patchRawCharacter("a", [["additionalAssets", raw("a").additionalAssets]]);
        expect(isFrozenAssetList(byId("a").additionalAssets)).toBe(true);
        expect(cacheable("a")).toBe(true);
    });
});

describe("a whole-field write", () => {
    it("stores a wholly owned frozen copy: the input stays mutable and unlinked, verified entries are shared, the field is stamped", () => {
        initializeRecords({ characters: [fixture()] });
        const a = byId("a");
        const kept = a.additionalAssets[1];
        const input: Tuple[] = [tuple("new"), a.additionalAssets[1]];
        const changed = effects("a", () => (a.additionalAssets = input));
        expect(changed).toEqual({ text: true, stamps: ["additionalAssets"], writes: 1 });
        expect(Object.isFrozen(input)).toBe(false);
        expect(Object.isFrozen(input[0])).toBe(false);
        const stored = a.additionalAssets;
        expect(stored).not.toBe(input);
        expect(isFrozenAssetList(stored)).toBe(true);
        expect(Object.isFrozen(stored[0])).toBe(true);
        // The verified entry is reused as itself; the new one is a frozen copy.
        expect(stored[1]).toBe(kept);
        expect(stored[0]).not.toBe(input[0]);
        input[0][0] = "edited after the write";
        input.push(tuple("pushed after the write"));
        expect(plain(a.additionalAssets)).toEqual([tuple("new"), tuple("two")]);
        expect(characterFieldPlain("a", "additionalAssets")).toBe(stored);

        // The same for pairs and records (an edit built from the old list).
        const joy = a.emotionImages[0];
        a.emotionImages = a.emotionImages.map((pair: string[], i: number) => (i === 1 ? ["serene", pair[1]] : pair));
        expect(a.emotionImages[0]).toBe(joy);
        expect(plain(a.emotionImages)).toEqual([
            ["joy", "emotions/joy.png"],
            ["serene", "emotions/calm.png"],
        ]);
        const first = a.ccAssets[0];
        a.ccAssets = [...a.ccAssets, icon("third")];
        expect(a.ccAssets[0]).toBe(first);
        expect(Object.isFrozen(a.ccAssets[2])).toBe(true);
        expect(plain(a.ccAssets)).toEqual([icon("first"), icon("second"), icon("third")]);
        // A verified frozen list assigned whole (the same shape) is stored as itself: no copy, nothing to taint.
        a.emotionImages = a.additionalAssets;
        expect(plain(a.emotionImages)).toEqual(plain(a.additionalAssets));
        expect(a.emotionImages[0]).toBe(a.additionalAssets[0]);
        expect(isFrozenAssetList(a.emotionImages)).toBe(true);
        expect(cacheable("a")).toBe(true);
        expect(JSON.stringify(a)).toBe(JSON.stringify(raw("a")));
    });

    it("a defineProperty write, a stored character (insert, replace) and a same-id replacement keeping the list", () => {
        initializeRecords({ characters: [fixture()] });
        const a = byId("a");
        const defined = [tuple("defined")];
        define(a, "additionalAssets", defined);
        expect(Object.isFrozen(defined)).toBe(false);
        expect(isFrozenAssetList(a.additionalAssets)).toBe(true);
        expect(plain(a.additionalAssets)).toEqual([tuple("defined")]);

        const inserted = { chaId: "b", name: "B", additionalAssets: [tuple("b")], ccAssets: [icon("b")] };
        insertCharacterRecord(inserted);
        expect(Object.isFrozen(inserted.additionalAssets)).toBe(false);
        expect(Object.isFrozen(inserted.ccAssets[0])).toBe(false);
        expect(isFrozenAssetList(byId("b").additionalAssets)).toBe(true);
        expect(isFrozenAssetList(byId("b").ccAssets)).toBe(true);
        inserted.additionalAssets[0][0] = "edited";
        expect(plain(byId("b").additionalAssets)).toEqual([tuple("b")]);

        // A same-id replacement that passes the live frozen list stores it as itself (no copy; the
        // retained value is immutable either way).
        const held = byId("b").additionalAssets;
        replaceCharacterRecordAt(1, { chaId: "b", name: "B2", additionalAssets: held, ccAssets: [icon("c")] });
        expect(isFrozenAssetList(byId("b").additionalAssets)).toBe(true);
        expect(plain(byId("b").additionalAssets)).toEqual([tuple("b")]);
        expect(byId("b").additionalAssets[0]).toBe(held[0]);
        expect(plain(byId("b").ccAssets)).toEqual([icon("c")]);
        expect(byId("b").name).toBe("B2");
        expect(cacheable("a")).toBe(true);
        expect(cacheable("b")).toBe(true);
    });
});

describe("ownership", () => {
    it("same-character unproxied containers and nested aliases are copied, never frozen; own $state edits are read through descriptors", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", additionalAssets: [] }] });
        const a = byId("a");
        define(a, "rows", [tuple("row")]);
        a.additionalAssets = a.rows;
        expect(Object.isFrozen(raw("a").rows)).toBe(false);
        expect(Object.isFrozen(raw("a").rows[0])).toBe(false);
        expect(isFrozenAssetList(a.additionalAssets)).toBe(true);
        a.rows[0][0] = "edited through the source";
        a.rows.push(tuple("pushed"));
        expect(plain(a.rows)).toEqual([["edited through the source", "assets/row.png", "png"], tuple("pushed")]);
        expect(plain(a.additionalAssets)).toEqual([tuple("row")]);

        define(a, "more", [tuple("m")]);
        a.emotionImages = [a.more[0]];
        expect(Object.isFrozen(raw("a").more[0])).toBe(false);
        a.more[0][0] = "still editable";
        expect(plain(a.emotionImages)).toEqual([tuple("m")]);

        // A proxied own list: edits, a push and a shrink are what the copy sees.
        a.state = [tuple("s")];
        a.state[0][0] = "edited";
        a.state.push(tuple("pushed"));
        a.additionalAssets = a.state;
        expect(plain(a.additionalAssets)).toEqual([["edited", "assets/s.png", "png"], tuple("pushed")]);
        expect(Object.isFrozen(raw("a").state)).toBe(false);
        a.state.length = 1;
        a.additionalAssets = a.state;
        expect(plain(a.additionalAssets)).toEqual([["edited", "assets/s.png", "png"]]);
        a.state[0][0] = "edited again";
        expect(plain(a.additionalAssets)).toEqual([["edited", "assets/s.png", "png"]]);
        expect(cacheable("a")).toBe(true);
    });

    it("another character's list and a foreign $state list are copied, not frozen, and not linked", () => {
        initializeRecords({
            characters: [
                { chaId: "a", name: "A", additionalAssets: [], rows: [tuple("a-row")] },
                { chaId: "b", name: "B", additionalAssets: [tuple("b")], rows: [tuple("b-row")] },
            ],
        });
        const a = byId("a");
        const b = byId("b");
        a.additionalAssets = b.rows;
        expect(Object.isFrozen(raw("b").rows)).toBe(false);
        b.rows[0][0] = "edited in b";
        expect(plain(a.additionalAssets)).toEqual([tuple("b-row")]);
        // A frozen list of another character is shared as itself (immutable).
        a.additionalAssets = b.additionalAssets;
        expect(a.additionalAssets[0]).toBe(b.additionalAssets[0]);
        b.additionalAssets = [tuple("b2")];
        expect(plain(a.additionalAssets)).toEqual([tuple("b")]);
        expect(cacheable("a")).toBe(true);
        expect(cacheable("b")).toBe(true);
    });
});

describe("unsupported shapes take the mutable fallback with the ordinary adoption's JSON", () => {
    const cases: { name: string; field: string; input: () => unknown }[] = [
        {
            name: "trailing holes written through length",
            field: "additionalAssets",
            input: () => {
                const held = [tuple("name")];
                held.length = 3;
                return held;
            },
        },
        { name: "a class instance entry", field: "ccAssets", input: () => [new Date(0)] },
        {
            name: "an accessor in a record entry",
            field: "ccAssets",
            input: () => [Object.defineProperty({ ...icon("x") }, "extra", { get: () => "g", enumerable: true })],
        },
        {
            name: "a numeric key outside the index range",
            field: "additionalAssets",
            input: () => {
                const supplied: any = new Array(1);
                supplied["4294967295"] = tuple("name");
                return supplied;
            },
        },
        { name: "a hole inside the list", field: "additionalAssets", input: () => [tuple("a"), , tuple("c")] },
        { name: "a nested object in a tuple", field: "emotionImages", input: () => [["joy", { path: 1 }]] },
        { name: "a primitive entry", field: "additionalAssets", input: () => ["not a tuple"] },
        {
            name: "a tuple with an extra key",
            field: "additionalAssets",
            input: () => Object.assign(tuple("x"), { extra: 1 }) && [Object.assign(tuple("x"), { extra: 1 })],
        },
        { name: "a record with a toJSON key", field: "ccAssets", input: () => [{ ...icon("x"), toJSON: 1 }] },
        {
            name: "a record with an own __proto__ key",
            field: "ccAssets",
            input: () => [JSON.parse('{"__proto__":1,"name":"x"}')],
        },
        { name: "a record with a symbol key", field: "ccAssets", input: () => [{ ...icon("x"), [Symbol("s")]: 1 }] },
        {
            name: "a null-prototype record",
            field: "ccAssets",
            input: () => [Object.assign(Object.create(null), icon("x"))],
        },
        { name: "a list of the other shape", field: "ccAssets", input: () => [tuple("x")] },
        { name: "an object, not a list", field: "additionalAssets", input: () => ({ 0: tuple("x"), length: 1 }) },
    ];
    for (const { name, field, input } of cases) {
        it(name, () => {
            initializeRecords({ characters: [{ chaId: "a", name: "A", [field]: [] }] });
            const a = byId("a");
            const value = input();
            const expected = JSON.stringify(value);
            // Plain and through this character's own wrapper (the live value), as the challenge wrote it.
            a[field] = value;
            expect(JSON.stringify(raw("a")[field])).toBe(expected);
            expect(Object.isFrozen(raw("a")[field])).toBe(false);
            expect(isFrozenAssetList(a[field])).toBe(false);
            expect(isRecordWrapper(a[field])).toBe(true);
            a.rows = input();
            a[field] = a.rows;
            expect(JSON.stringify(raw("a")[field])).toBe(expected);
            expect(Object.isFrozen(raw("a")[field])).toBe(false);
            expect(Object.isFrozen(raw("a").rows)).toBe(false);
        });
    }

    it("a mutable fallback list still works through its wrapper and becomes frozen once a valid list is written", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", additionalAssets: [tuple("ok"), { odd: 1 }] }] });
        const a = byId("a");
        const held = a.additionalAssets;
        held.splice(1, 1);
        held.push(tuple("pushed"));
        expect(plain(raw("a").additionalAssets)).toEqual([tuple("ok"), tuple("pushed")]);
        expect(isFrozenAssetList(a.additionalAssets)).toBe(false);
        a.additionalAssets = held;
        expect(isFrozenAssetList(a.additionalAssets)).toBe(true);
        expect(plain(a.additionalAssets)).toEqual([tuple("ok"), tuple("pushed")]);
        expect(cacheable("a")).toBe(true);
    });
});

describe("refused writes", () => {
    it("every in-place write into a frozen list or entry throws before anything changes, for the three fields", () => {
        initializeRecords({ characters: [fixture()] });
        const a = byId("a");
        a.name = "settled";
        const writes: ((field: string) => void)[] = [
            (f) => (a[f][0] = tuple("x")),
            (f) => (a[f].length = 0),
            (f) => a[f].push(tuple("x")),
            (f) => a[f].splice(0, 1),
            (f) => a[f].sort(),
            (f) => a[f].reverse(),
            (f) => a[f].pop(),
            (f) => a[f].shift(),
            (f) => a[f].unshift(tuple("x")),
            (f) => a[f].fill(tuple("x")),
            (f) => a[f].copyWithin(0, 1),
            (f) => delete a[f][0],
            (f) => define(a[f], "0", tuple("x")),
            (f) => define(a[f], "extra", 1),
            (f) => replaceRecordList(a[f], []),
            (f) => moveRecordListItem(a[f], 0, 1),
            (f) => (a[f][0][0] = "x"),
            (f) => (a[f][0].name = "x"),
            (f) => delete a[f][0][f === "ccAssets" ? "name" : "0"],
            (f) => define(a[f][0], "0", "x"),
            (f) => (a[f][0].length = 0),
            (f) => (f === "ccAssets" ? (a[f][0].ext = "x") : a[f][0].push("x")),
            (f) => replaceRecordList(a[f][0], []),
            (f) => Object.assign(a[f][0], { name: "x" }),
        ];
        for (const field of FIELDS) {
            for (const write of writes) {
                const result = effects("a", () => expect(() => write(field), `${field}: ${write}`).toThrow(TypeError));
                expect(result, `${field}: ${write}`).toEqual({ text: false, stamps: [], writes: 0 });
            }
            // Strict-mode semantics on the raw frozen value as well.
            expect(() => (raw("a")[field][0] = 1)).toThrow(TypeError);
        }
        // The ordinary field next to them is still editable in place.
        a.rows[0][0] = "edited";
        a.rows.push(tuple("pushed"));
        expect(plain(a.rows)).toEqual([["edited", "assets/row.png", "png"], tuple("pushed")]);
        expect(cacheable("a")).toBe(true);
        expect(JSON.stringify(a)).toBe(JSON.stringify(raw("a")));
    });
});

describe("retained wrappers and values", () => {
    const mutable = () => [tuple("seed"), { odd: 1 }];

    it("a mutable wrapper that later resolves to a frozen list follows it, keeps the Proxy invariants, is never a cache key, and stamps", () => {
        initializeRecords({ characters: [{ chaId: "a", name: "A", additionalAssets: mutable() }] });
        const a = byId("a");
        const held = a.additionalAssets;
        const entry = held[0];
        expect(isRecordWrapper(held)).toBe(true);
        expect(isRecordWrapper(entry)).toBe(true);
        const seen = new Set([wrapperFieldStamp(held)]);
        for (const next of [[tuple("old")], [tuple("new"), tuple("more")]]) {
            a.additionalAssets = next;
            expect(isRecordWrapper(held)).toBe(true);
            expect(isFrozenAssetList(held)).toBe(false);
            expect(isFrozenAssetList(a.additionalAssets)).toBe(true);
            expect(plain(held)).toEqual(next);
            expect(held.length).toBe(next.length);
            expect([...held]).toEqual(a.additionalAssets.map((item: Tuple) => item));
            expect(Object.keys(held)).toEqual(next.map((_, i) => String(i)));
            expect({ ...held }).toEqual({ ...next });
            expect(Array.from(held.entries())).toEqual(Array.from(next.entries()));
            expect(Object.getOwnPropertyDescriptor(held, "0")!.value).toBe(a.additionalAssets[0]);
            expect(held[0]).toBe(a.additionalAssets[0]);
            expect(Object.isFrozen(held[0])).toBe(true);
            // The retained wrapper of the old mutable entry stood for an object no longer in the record.
            expect(() => JSON.stringify(entry)).toThrow(DetachedWrapperError);
            const next_stamp = wrapperFieldStamp(held);
            expect(next_stamp).not.toBeNull();
            expect(seen.has(next_stamp)).toBe(false);
            seen.add(next_stamp);
            expect(wrapperFieldStamp(held)).toBe(stamp("a", "additionalAssets"));
        }
        // Writes through the retained wrapper are refused like any other.
        const result = effects("a", () => expect(() => held.push(tuple("x"))).toThrow(TypeError));
        expect(result).toEqual({ text: false, stamps: [], writes: 0 });
        expect(() => (held[0] = tuple("x"))).toThrow(TypeError);
        // Replaced with a list of another shape again: the wrapper is mutable again.
        a.additionalAssets = mutable();
        held.push(tuple("pushed"));
        expect(plain(raw("a").additionalAssets)).toEqual([tuple("seed"), { odd: 1 }, tuple("pushed")]);
        expect(cacheable("a")).toBe(true);
    });

    it("a retained frozen value remains the old value while the character wrapper (by chaId) follows a field and a whole replacement", () => {
        initializeRecords({ characters: [fixture()] });
        const a = byId("a");
        const old = a.additionalAssets;
        a.additionalAssets = [tuple("replaced")];
        expect(plain(old)).toEqual([tuple("one"), tuple("two")]);
        expect(plain(a.additionalAssets)).toEqual([tuple("replaced")]);
        expect(isFrozenAssetList(old)).toBe(true);

        const beforeWhole = a.additionalAssets;
        replaceCharacterRecordAt(0, { chaId: "a", name: "whole", additionalAssets: [tuple("whole")], ccAssets: [] });
        expect(plain(beforeWhole)).toEqual([tuple("replaced")]);
        expect(plain(a.additionalAssets)).toEqual([tuple("whole")]);
        expect(plain(byId("a").ccAssets)).toEqual([]);
        expect(a.name).toBe("whole");

        applyRawCharacter("a", { chaId: "a", name: "server", additionalAssets: [tuple("server")] });
        expect(plain(a.additionalAssets)).toEqual([tuple("server")]);
        expect(plain(beforeWhole)).toEqual([tuple("replaced")]);
        // A mutable wrapper retained across the whole replacement resolves to the frozen list there.
        a.additionalAssets = mutable();
        const held = a.additionalAssets;
        replaceCharacterRecordAt(0, { chaId: "a", name: "again", additionalAssets: [tuple("after")] });
        expect(plain(held)).toEqual([tuple("after")]);
        expect(isFrozenAssetList(held)).toBe(false);
        expect(wrapperFieldStamp(held)).toBe(stamp("a", "additionalAssets"));
        // Deleted and created again: the retained element wrapper is gone, a fresh one reads the new record.
        removeCharacterRecords(["a"]);
        insertCharacterRecord({ chaId: "a", name: "new", additionalAssets: [tuple("fresh")] });
        expect(plain(byId("a").additionalAssets)).toEqual([tuple("fresh")]);
        expect(isFrozenAssetList(byId("a").additionalAssets)).toBe(true);
    });
});

describe("local and ordinary fields", () => {
    it("reloadKeys may hold the frozen list raw, and the ordinary editable fields and their stamps are unaffected", () => {
        initializeRecords({ characters: [fixture()] });
        const a = byId("a");
        const assets = a.additionalAssets;
        const before = stamps("a");
        a.reloadKeys = { list: assets, plain: 1 };
        expect(plain(byId("a").reloadKeys.list)).toEqual(plain(assets));
        expect(Object.isFrozen(raw("a").reloadKeys.list)).toBe(true);
        expect(stamps("a")).toMatchObject(before);
        a.reloadKeys = 3;
        expect(raw("a").reloadKeys).toBe(3);
        // Ordinary fields keep their in-place semantics and stamp only themselves.
        expect(effects("a", () => (a.rows[0][0] = "edited")).stamps).toEqual(["rows"]);
        expect(effects("a", () => a.rows.push(tuple("pushed"))).stamps).toEqual(["rows"]);
        expect(effects("a", () => (a.name = "renamed")).stamps).toEqual(["name"]);
        expect(stamp("a", "additionalAssets")).toBe(before.additionalAssets);
        expect(stamp("a", "emotionImages")).toBe(before.emotionImages);
        expect(stamp("a", "ccAssets")).toBe(before.ccAssets);
        expect(isFrozenAssetList(a.additionalAssets)).toBe(true);
        expect(cacheable("a")).toBe(true);
    });

    it("characterFieldPlain returns the frozen list itself, memoized by stamp, and copies a mutable fallback", () => {
        initializeRecords({ characters: [fixture()] });
        const a = byId("a");
        const first = characterFieldPlain("a", "additionalAssets");
        expect(isFrozenAssetList(first)).toBe(true);
        expect(plain(first)).toEqual(plain(a.additionalAssets));
        a.name = "unrelated";
        expect(characterFieldPlain("a", "additionalAssets")).toBe(first);
        a.additionalAssets = [tuple("next")];
        const second = characterFieldPlain("a", "additionalAssets");
        expect(second).not.toBe(first);
        expect(isFrozenAssetList(second)).toBe(true);
        expect(plain(second)).toEqual([tuple("next")]);
        expect(characterFieldPlain("a", "additionalAssets")).toBe(second);
        expect(plain(first)).toEqual([tuple("one"), tuple("two")]);
        a.ccAssets = [{ type: "icon", nested: { deep: 1 } }];
        const copy = characterFieldPlain<any[]>("a", "ccAssets")!;
        expect(isRecordWrapper(copy)).toBe(false);
        expect(copy).not.toBe(raw("a").ccAssets);
        expect(plain(copy)).toEqual([{ type: "icon", nested: { deep: 1 } }]);
    });
});
