// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    applyItemPatch,
    checkFields,
    checkItemPatch,
    diffFields,
    diffItems,
    itemIds,
    RecordPatchError,
    withFields,
} from "../recordPatch.ts";

// Audit item A1: the record patch helpers the server store and the client share. The item-id rule
// (`itemIds`), the checks (`checkFields`, `checkItemPatch`), the applications (`withFields`,
// `applyItemPatch`), and the diffs the change feed is built from (`diffFields`, `diffItems`), with
// `__proto__` and `constructor` as field names and as ids, and a seeded round trip of random lists:
// applying `diffItems(old, next)` to `old` gives `next` as a JSON value.

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });
/** An object with an own `__proto__` key (a Svelte proxy or `JSON.parse` stores one). */
const withProto = (value: unknown, rest: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = { ...rest };
    Object.defineProperty(out, "__proto__", { value, enumerable: true, writable: true, configurable: true });
    return out;
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("itemIds", () => {
    it("lists the ids of a list of plain objects with unique non-empty string ids, in order, and null for anything else", () => {
        expect(itemIds([item("b"), item("a"), item("__proto__"), item("constructor")])).toEqual([
            "b",
            "a",
            "__proto__",
            "constructor",
        ]);
        expect(itemIds([])).toEqual([]);
        for (const list of [
            null,
            undefined,
            "ab",
            { 0: item("a"), length: 1 },
            [item("a"), item("a")],
            [item("a"), { name: "no id" }],
            [item("")],
            [{ id: 1 }],
            [{ id: null }],
            [item("a"), null],
            [item("a"), [item("b")]],
            [item("a"), "b"],
            // `id` must be an own property.
            [Object.create({ id: "inherited" })],
        ]) {
            expect(itemIds(list), JSON.stringify(list)).toBeNull();
        }
    });
});

describe("checkFields and withFields", () => {
    it("accepts set and remove in any combination, refuses an empty, repeated, forbidden, or __proto__ field", () => {
        expect(checkFields({ a: 1, b: undefined }, ["c"], "p")).toEqual({
            set: [
                ["a", 1],
                ["b", undefined],
            ],
            remove: ["c"],
        });
        expect(checkFields(undefined, ["c"], "p")).toEqual({ set: [], remove: ["c"] });
        expect(checkFields({ constructor: 1 }, undefined, "p")).toEqual({ set: [["constructor", 1]], remove: [] });
        const refused: [unknown, unknown, string][] = [
            [[], undefined, "p is { set?: object, remove?: string[] }"],
            // A null `set` or `remove` counts as absent.
            [null, null, "p names no field"],
            [undefined, "a", "p is { set?: object, remove?: string[] }"],
            [undefined, [1], "p is { set?: object, remove?: string[] }"],
            [undefined, undefined, "p names no field"],
            [{}, [], "p names no field"],
            [{ a: 1 }, ["a"], "p names a field twice or names __proto__"],
            [undefined, ["a", "a"], "p names a field twice or names __proto__"],
            [JSON.parse('{"__proto__":1}'), undefined, "p names a field twice or names __proto__"],
            [undefined, ["__proto__"], "p names a field twice or names __proto__"],
        ];
        for (const [set, remove, message] of refused) {
            expect(() => checkFields(set, remove, "p")).toThrow(new RecordPatchError(message));
        }
        expect(() => checkFields({ id: "x" }, undefined, "p", ["id"])).toThrow(new RecordPatchError("p names id"));
        expect(() => checkFields(undefined, ["id"], "p", ["id"])).toThrow(new RecordPatchError("p names id"));
    });

    it("withFields copies the record with the fields assigned and deleted, keeping an own __proto__ key", () => {
        const record = withProto({ x: 1 }, { keep: 1, change: 2, drop: 3 });
        const next = withFields(
            record,
            [
                ["change", 20],
                ["added", null],
                ["constructor", "own"],
            ],
            ["drop", "none"],
        );
        expect(next).not.toBe(record);
        expect(record).toEqual(withProto({ x: 1 }, { keep: 1, change: 2, drop: 3 }));
        expect(Object.keys(next)).toEqual(["keep", "change", "__proto__", "added", "constructor"]);
        expect(Object.getOwnPropertyDescriptor(next, "__proto__")!.value).toEqual({ x: 1 });
        expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
        expect(next).toMatchObject({ keep: 1, change: 20, added: null, constructor: "own" });
        expect(Object.hasOwn(next, "drop")).toBe(false);
    });
});

describe("checkItemPatch and applyItemPatch", () => {
    it("checks the items, the changes (never naming id), and the order, with no id twice", () => {
        const checked = checkItemPatch({
            items: [item("new", { n: 1 })],
            changes: [
                { id: "a", set: { n: 2 } },
                { id: "b", remove: ["n"] },
            ],
            order: ["new", "a", "b"],
        });
        expect(checked).toEqual({
            items: [item("new", { n: 1 })],
            changes: [
                { id: "a", set: [["n", 2]], remove: [] },
                { id: "b", set: [], remove: ["n"] },
            ],
            order: ["new", "a", "b"],
        });
        expect(checkItemPatch({ order: [] })).toEqual({ items: [], changes: [], order: [] });
        expect(checkItemPatch({ items: [item("a")] })).toEqual({ items: [item("a")], changes: [], order: null });
        // Extra fields (a feed entry's `baseRevision`) are ignored.
        expect(checkItemPatch({ baseRevision: "r", order: ["a"] })).toEqual({ items: [], changes: [], order: ["a"] });
        const refused: [unknown, string][] = [
            [{}, "an item patch changes nothing"],
            [{ items: [], changes: [] }, "an item patch changes nothing"],
            [{ items: 1 }, "an item patch is { items?: object[], changes?: object[], order?: string[] }"],
            [{ changes: {} }, "an item patch is { items?: object[], changes?: object[], order?: string[] }"],
            [{ items: [null] }, "items[0] is not an object with an id"],
            [{ items: [[]] }, "items[0] is not an object with an id"],
            [{ items: [{}] }, "items[0] is not an object with an id"],
            [{ items: [{ id: "" }] }, "items[0] has no id"],
            [{ items: [item("a"), { id: 2 }] }, "items[1] has no id"],
            [{ changes: ["a"] }, "changes[0] is { id, set?, remove? }"],
            [{ changes: [{ id: "", set: { n: 1 } }] }, "changes[0] has no id"],
            [{ changes: [{ id: "a" }] }, "changes[0] names no field"],
            [{ changes: [{ id: "a", set: { id: "b" } }] }, "changes[0] names id"],
            [{ changes: [{ id: "a", remove: ["id"] }] }, "changes[0] names id"],
            [
                {
                    changes: [
                        { id: "a", set: { n: 1 } },
                        { id: "a", set: { n: 2 } },
                    ],
                },
                'an item patch names the item "a" twice',
            ],
            [{ items: [item("a")], changes: [{ id: "a", set: { n: 2 } }] }, 'an item patch names the item "a" twice'],
            [{ order: null }, "an item patch's order is a list of ids"],
            [{ order: [1] }, "an item patch's order is a list of ids"],
            [{ order: ["a", "a"] }, "an item patch's order names an id twice"],
        ];
        for (const [patch, message] of refused) {
            expect(() => checkItemPatch(patch as Record<string, unknown>), JSON.stringify(patch)).toThrow(
                new RecordPatchError(message),
            );
        }
    });

    it("applies items by id, field changes to base items, and an explicit order; refuses what does not fit the base", () => {
        const base = [item("a", { n: 1, keep: true }), item("b"), item("__proto__", { n: 0 }), item("constructor")];
        // Without an order: ids and order are the base's, base items are reused as they are.
        const same = applyItemPatch(base, checkItemPatch({ changes: [{ id: "a", set: { n: 2 }, remove: ["keep"] }] }));
        expect(same).toEqual([item("a", { n: 2 }), item("b"), item("__proto__", { n: 0 }), item("constructor")]);
        expect(same[1]).toBe(base[1]);
        expect(same[0]).not.toBe(base[0]);
        expect(base[0]).toEqual(item("a", { n: 1, keep: true }));
        // Prototype-named ids resolve by value, never through the prototype chain.
        expect(
            applyItemPatch(
                base,
                checkItemPatch({
                    items: [item("constructor", { c: 1 })],
                    changes: [{ id: "__proto__", set: { n: 9 } }],
                }),
            ),
        ).toEqual([
            item("a", { n: 1, keep: true }),
            item("b"),
            item("__proto__", { n: 9 }),
            item("constructor", { c: 1 }),
        ]);
        // With an order: new items, moves, and removals; an empty order clears.
        expect(
            applyItemPatch(base, checkItemPatch({ items: [item("new")], order: ["new", "constructor", "a"] })),
        ).toEqual([item("new"), item("constructor"), item("a", { n: 1, keep: true })]);
        expect(applyItemPatch(base, checkItemPatch({ order: [] }))).toEqual([]);
        expect(applyItemPatch([], checkItemPatch({ items: [item("x")], order: ["x"] }))).toEqual([item("x")]);
        const refused: [unknown, unknown, string][] = [
            [{ id: "a" }, { order: [] }, "the record's items have no unique ids"],
            [[item("a"), item("a")], { order: [] }, "the record's items have no unique ids"],
            [[item("a"), {}], { order: ["a"] }, "the record's items have no unique ids"],
            [base, { changes: [{ id: "zz", set: { n: 1 } }] }, 'the item "zz" is not in the record'],
            [base, { changes: [{ id: "toString", set: { n: 1 } }] }, 'the item "toString" is not in the record'],
            [base, { items: [item("zz")] }, 'the item "zz" is not in the record'],
            [base, { items: [item("zz")], order: ["a"] }, 'the patched item "zz" is not in the order'],
            [base, { changes: [{ id: "b", set: { n: 1 } }], order: ["a"] }, 'the patched item "b" is not in the order'],
            [base, { order: ["a", "zz"] }, 'the order names the unknown item "zz"'],
            [base, { order: ["a", "hasOwnProperty"] }, 'the order names the unknown item "hasOwnProperty"'],
        ];
        for (const [list, patch, message] of refused) {
            expect(() => applyItemPatch(list, checkItemPatch(patch as Record<string, unknown>)), message).toThrow(
                new RecordPatchError(message),
            );
        }
    });
});

describe("diffFields and diffItems", () => {
    it("diffFields finds the fields whose JSON text differs, own keys only, and gives up on a changed __proto__", () => {
        // Top-level key order is not a change; a nested value's key order is (the texts differ), so
        // such a field is carried again with the same value, never left out when its value changed.
        const old = { same: 1, change: { k: [1] }, drop: 3, reorder: { a: 1, b: 2 }, constructor: "c" };
        const next = { constructor: "c", reorder: { b: 2, a: 1 }, added: null, change: { k: [2] }, same: 1 };
        expect(diffFields(old, next)).toEqual({
            set: { reorder: { b: 2, a: 1 }, added: null, change: { k: [2] } },
            remove: ["drop"],
        });
        expect(diffFields(old, { ...old })).toEqual({ set: {}, remove: [] });
        // An undefined value has no JSON text: a field set to it reads as removed, a new one as absent.
        expect(diffFields({ a: 1 }, { a: undefined })).toEqual({ set: { a: undefined }, remove: [] });
        expect(diffFields({}, { toString: "own" })).toEqual({ set: { toString: "own" }, remove: [] });
        expect(diffFields({ toString: "own" }, {})).toEqual({ set: {}, remove: ["toString"] });
        // An unchanged own `__proto__` is fine; a changed, added, or removed one is null.
        expect(diffFields(withProto(1, { n: 1 }), withProto(1, { n: 2 }))).toEqual({ set: { n: 2 }, remove: [] });
        expect(diffFields(withProto(1), withProto(2))).toBeNull();
        expect(diffFields({}, withProto(1))).toBeNull();
        expect(diffFields(withProto(1), {})).toBeNull();
    });

    it("diffItems gives a new or __proto__-changed item whole, a changed one as fields, the order when it changed, and null without unique ids", () => {
        const old = [item("a", { n: 1 }), item("b", { keep: 1 }), item("c")];
        expect(
            diffItems(
                old,
                old.map((entry) => ({ ...entry })),
            ),
        ).toEqual({ items: [], changes: [] });
        expect(diffItems(old, [item("a", { n: 2 }), item("b", { keep: 1 }), item("c")])).toEqual({
            items: [],
            changes: [{ id: "a", set: { n: 2 }, remove: [] }],
        });
        expect(diffItems(old, [item("c"), item("d"), item("a", { m: 1 })])).toEqual({
            items: [item("d")],
            changes: [{ id: "a", set: { m: 1 }, remove: ["n"] }],
            order: ["c", "d", "a"],
        });
        expect(diffItems(old, [])).toEqual({ items: [], changes: [], order: [] });
        expect(diffItems([], old)).toEqual({ items: old, changes: [], order: ["a", "b", "c"] });
        // The same ids in the same order after a removal and an addition is still a reorder of ids.
        expect(diffItems(old, [item("a", { n: 1 }), item("x"), item("c")])).toEqual({
            items: [item("x")],
            changes: [],
            order: ["a", "x", "c"],
        });
        const protoChanged = diffItems([withProto(1, { id: "a" })], [withProto(2, { id: "a" })]);
        expect(protoChanged!.changes).toEqual([]);
        expect(protoChanged!.items).toHaveLength(1);
        expect(Object.getOwnPropertyDescriptor(protoChanged!.items[0], "__proto__")!.value).toBe(2);
        expect(diffItems([item("a"), item("a")], [item("a")])).toBeNull();
        expect(diffItems([item("a")], [item("a"), { name: "no id" }])).toBeNull();
        expect(diffItems({ id: "a" }, [item("a")])).toBeNull();
    });

    it("round-trips random lists: applying diffItems(old, next) to old gives next", () => {
        // A small seeded generator (mulberry32), so a failure reproduces.
        let seed = 0x1a2b3c4d;
        const random = () => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
        const IDS = ["a", "b", "c", "d", "e", "__proto__", "constructor", "toString", "valueOf"];
        const FIELDS = ["n", "name", "deep", "list", "__proto__", "constructor", "hasOwnProperty"];
        const value = (): unknown =>
            pick([() => random(), () => "s", () => null, () => [1, { k: 2 }], () => ({ a: [random()] }), () => true])();
        const randomItem = (id: string) => {
            const out: Record<string, unknown> = { id };
            for (const field of FIELDS) {
                if (random() < 0.5) {
                    Object.defineProperty(out, field, {
                        value: value(),
                        enumerable: true,
                        writable: true,
                        configurable: true,
                    });
                }
            }
            return out;
        };
        const randomList = () => {
            const ids = IDS.filter(() => random() < 0.6).sort(() => random() - 0.5);
            return ids.map(randomItem);
        };
        /** `next` as a mutation of `old`: some items kept, some changed, some new, in a new order. */
        const mutate = (old: Record<string, unknown>[]) => {
            const next = old
                .filter(() => random() < 0.7)
                .map((entry) => (random() < 0.5 ? entry : randomItem(entry.id as string)));
            for (const id of IDS) {
                if (!next.some((entry) => entry.id === id) && random() < 0.2) {
                    next.push(randomItem(id));
                }
            }
            return random() < 0.5 ? next : next.sort(() => random() - 0.5);
        };
        let patches = 0;
        for (let round = 0; round < 400; round += 1) {
            const old = randomList();
            const next = random() < 0.5 ? randomList() : mutate(old);
            const diff = diffItems(old, next)!;
            expect(diff, `round ${round}`).not.toBeNull();
            // The diff is a valid patch unless nothing changed at all, and applying it gives `next`.
            const changed = diff.items.length > 0 || diff.changes.length > 0 || diff.order !== undefined;
            if (!changed) {
                expect(plain(old), `round ${round}: unchanged`).toEqual(plain(next));
                continue;
            }
            patches += 1;
            const applied = applyItemPatch(plain(old), checkItemPatch(plain(diff)));
            expect(plain(applied), `round ${round}`).toEqual(plain(next));
            expect(
                applied.map((entry) => entry.id),
                `round ${round}: order`,
            ).toEqual(next.map((entry) => entry.id));
            // Own `__proto__` keys survive as data on both sides.
            applied.forEach((entry, index) => {
                expect(Object.hasOwn(entry, "__proto__"), `round ${round}: item ${index}`).toBe(
                    Object.hasOwn(next[index], "__proto__"),
                );
            });
        }
        expect(patches).toBeGreaterThan(300);
    });
});
