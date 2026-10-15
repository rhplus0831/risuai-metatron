import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    applyRaw,
    batchRecordWrites,
    initializeRecords,
    moduleItemFieldStamp,
    moveRecordListItem,
    recordData,
    replaceRecord,
    replaceRecordList,
    resetRecords,
    setRecordWriteListener,
    trackedRecord,
} from "../records.svelte";

// The save loop's module field-text stamps (`moduleItemFieldStamp`, `docs/structure/persistence.md`
// save step 2), checked on the records module alone: a write through a wrapper under an element's
// top-level field changes that field's stamp of that element and no other, on every write path (set
// at depth, delete, defineProperty, each array mutator, `replaceRecordList`, `moveRecordListItem`,
// batched writes); a change of the root list (a reorder, a deletion, a swap, the UI's self-assignment,
// a whole-list replacement reusing the elements) keeps every element's stamps, since they follow the
// element's identity, not its index or id; plain JSON written under modules is copied, so the caller's
// object is not linked; and the record comes to have null stamps (uncacheable) when state is shared
// between two element fields or two elements, or data that is not plain JSON enters, until fresh
// detached data is installed (`applyRaw`), and not for the ordinary same-field reuses.

type Module = Record<string, any>;
const raw = () => recordData<Module[]>("modules")!;
const list = () => trackedRecord<Module[]>("modules")!;
const define = (target: object, key: string | symbol, value: unknown) =>
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
/** The stamps of every own field of a live element (`recordData`'s object, not a wrapper). */
const stampsOf = (element: Module): Record<string, number | null> =>
    Object.fromEntries(Object.keys(element).map((field) => [field, moduleItemFieldStamp(element, field)]));
/** Whether the record's texts may be cached at all (one probe of one field). */
const cacheable = () => moduleItemFieldStamp(raw()[0], "id") !== null;

/** Runs `write` and returns the fields of `element` whose stamp changed. */
function changed(element: Module, write: () => void): string[] {
    const before = stampsOf(element);
    write();
    const after = stampsOf(element);
    return Object.keys({ ...before, ...after }).filter((field) => before[field] !== after[field]);
}

const fixture = () => [
    { id: "a", name: "A", lorebook: [{ key: "k", content: "c" }], assets: [["x", "assets/x.png", "png"]] },
    { id: "b", name: "B", lorebook: [{ key: "j", content: "d" }] },
];

beforeEach(() => {
    resetRecords();
    setRecordWriteListener(() => {});
    initializeRecords({ modules: fixture() });
});
afterEach(() => resetRecords());

describe("a write under an element field stamps that field of that element only", () => {
    it("set at any depth, a new field, delete, defineProperty, a batched write, a length write", () => {
        const [a, b] = raw();
        const wa = list()[0];
        expect(typeof moduleItemFieldStamp(a, "name")).toBe("number");
        expect(moduleItemFieldStamp(a, "name")).toBe(moduleItemFieldStamp(a, "lorebook"));
        const bBefore = stampsOf(b);
        expect(changed(a, () => (wa.lorebook[0].content = "e"))).toEqual(["lorebook"]);
        expect(changed(a, () => (wa.name = "N"))).toEqual(["name"]);
        expect(changed(a, () => (wa.extra = { n: 1 }))).toEqual(["extra"]);
        expect(changed(a, () => (wa.extra.n = 2))).toEqual(["extra"]);
        expect(changed(a, () => define(wa, "defined", [1]))).toEqual(["defined"]);
        expect(changed(a, () => define(wa.defined, "0", 2))).toEqual(["defined"]);
        expect(changed(a, () => delete wa.extra)).toEqual(["extra"]);
        expect(changed(a, () => (wa.lorebook.length = 0))).toEqual(["lorebook"]);
        // Stamped at write time, not when the batch ends.
        const before = moduleItemFieldStamp(a, "name");
        batchRecordWrites(() => {
            wa.name = "M";
            expect(moduleItemFieldStamp(a, "name")).not.toBe(before);
        });
        expect(stampsOf(b)).toEqual(bBefore);
        expect(cacheable()).toBe(true);
    });

    it("each array mutator, replaceRecordList, and moveRecordListItem under a field", () => {
        const [a, b] = raw();
        const wa = list()[0];
        const bBefore = stampsOf(b);
        expect(changed(a, () => wa.lorebook.push({ key: "p", content: "p" }))).toEqual(["lorebook"]);
        expect(changed(a, () => wa.lorebook.unshift({ key: "u", content: "u" }))).toEqual(["lorebook"]);
        expect(changed(a, () => wa.lorebook.splice(1, 1))).toEqual(["lorebook"]);
        expect(changed(a, () => wa.lorebook.reverse())).toEqual(["lorebook"]);
        expect(changed(a, () => wa.lorebook.sort((x: any, y: any) => x.key.localeCompare(y.key)))).toEqual([
            "lorebook",
        ]);
        expect(changed(a, () => wa.lorebook.pop())).toEqual(["lorebook"]);
        expect(changed(a, () => wa.assets.push(["y", "assets/y.png", "png"]))).toEqual(["assets"]);
        expect(changed(a, () => replaceRecordList(wa.lorebook, [wa.lorebook[0], { key: "n", content: "n" }]))).toEqual([
            "lorebook",
        ]);
        expect(changed(a, () => moveRecordListItem(wa.lorebook, 0, 1))).toEqual(["lorebook"]);
        // The ordinary same-field reuses (`ModuleMenu.svelte`'s `currentModule.lorebook = currentModule.lorebook`).
        expect(changed(a, () => (wa.lorebook = wa.lorebook))).toEqual(["lorebook"]);
        expect(changed(a, () => wa.lorebook.push(wa.lorebook[0]))).toEqual(["lorebook"]);
        expect(stampsOf(b)).toEqual(bBefore);
        expect(cacheable()).toBe(true);
    });
});

describe("a change of the root list keeps the elements' stamps", () => {
    it("reverse, splice, unshift, an indexed swap, the self-assignment, and a list replacement reusing the elements", () => {
        const [a, b] = raw();
        const wa = list()[0];
        wa.name = "edited";
        const aBefore = stampsOf(a);
        const bBefore = stampsOf(b);
        const unchanged = () => {
            expect(stampsOf(a)).toEqual(aBefore);
            expect(stampsOf(b)).toEqual(bBefore);
            expect(cacheable()).toBe(true);
        };
        list().reverse();
        expect(raw()[0]).toBe(b);
        unchanged();
        list().unshift({ id: "c", name: "C" });
        unchanged();
        list().splice(0, 1);
        // `ModuleSettings.svelte`'s delete: a splice and `settings.modules = settings.modules`.
        replaceRecord("modules", list());
        expect(raw()).toEqual([b, a].map((entry) => JSON.parse(JSON.stringify(entry))));
        unchanged();
        const [first, second] = [list()[0], list()[1]];
        list()[0] = second;
        list()[1] = first;
        expect(raw()[0]).toBe(a);
        unchanged();
        replaceRecordList(list(), [list()[1], list()[0]]);
        expect(raw()[0]).toBe(b);
        unchanged();
        // A new element in a slot has stamps of its own; the others keep theirs.
        list()[1] = { id: "d", name: "D" };
        expect(stampsOf(b)).toEqual(bBefore);
        expect(typeof moduleItemFieldStamp(raw()[1], "name")).toBe("number");
        expect(cacheable()).toBe(true);
    });
});

describe("plain JSON written under modules is copied", () => {
    it("a pushed module, a replaced field, and a whole-list replacement are not linked to the caller's objects", () => {
        const pushed = { id: "c", name: "C", lorebook: [{ key: "k", content: "before" }] };
        list().push(pushed);
        pushed.lorebook[0].content = "outside";
        pushed.name = "outside";
        expect(raw()[2]).toEqual({ id: "c", name: "C", lorebook: [{ key: "k", content: "before" }] });

        const lore = [{ key: "f", content: "fresh" }];
        list()[0].lorebook = lore;
        lore[0].content = "outside";
        expect(raw()[0].lorebook).toEqual([{ key: "f", content: "fresh" }]);

        const whole = [{ id: "w", name: "W", lorebook: [{ key: "x", content: "x" }] }];
        replaceRecord("modules", whole);
        whole[0].lorebook[0].content = "outside";
        expect(raw()).toEqual([{ id: "w", name: "W", lorebook: [{ key: "x", content: "x" }] }]);
        // An own `__proto__` key written in stays a key.
        list()[0].lorebook.push(JSON.parse('{"__proto__":{"k":1},"content":"p"}'));
        expect(Object.getOwnPropertyDescriptor(raw()[0].lorebook[1], "__proto__")!.value).toEqual({ k: 1 });
        expect(cacheable()).toBe(true);
    });
});

describe("shared state or data that is not plain JSON makes every module stamp null until fresh data arrives", () => {
    const cases: [string, () => void][] = [
        ["a field shared between two fields of one module", () => (list()[0].assets = list()[0].lorebook)],
        ["a field shared between two modules", () => (list()[1].lorebook = list()[0].lorebook)],
        ["a lore entry pushed onto the root list", () => list().push(list()[0].lorebook[0])],
        ["a lore entry of one module pushed into another's", () => list()[1].lorebook.push(list()[0].lorebook[0])],
        [
            "a whole-list replacement spreading a module (its children shared with the original)",
            () => replaceRecord("modules", [{ ...list()[0], id: "copy" }, list()[0]]),
        ],
        ["a function", () => (list()[0].fn = () => 1)],
        ["a toJSON hook", () => (list()[0].hooked = { toJSON: () => 1 })],
        ["a class instance", () => (list()[0].instance = new (class Thing {})())],
        ["a null-prototype object", () => (list()[0].bare = Object.create(null))],
        ["a symbol key", () => ((list()[0] as any)[Symbol("tag")] = 1)],
        [
            "an own __proto__ key on a module with object children (the element is rebuilt)",
            () => ((list()[0] as any).__proto__ = { tag: 1 }),
        ],
    ];
    for (const [name, write] of cases) {
        it(name, () => {
            expect(cacheable()).toBe(true);
            write();
            expect(moduleItemFieldStamp(raw()[0], "id")).toBeNull();
            expect(moduleItemFieldStamp(raw()[raw().length - 1], "id")).toBeNull();
            // The server's copy (a read, a live update, a conflict reload) is fresh detached data.
            applyRaw("modules", fixture());
            expect(cacheable()).toBe(true);
            list()[0].name = "after";
            expect(cacheable()).toBe(true);
        });
    }

    it("the rebuilt module keeps its own __proto__ key and the write that followed", () => {
        (list()[0] as any).__proto__ = { tag: 1 };
        list()[0].lorebook[0].content = "edited";
        expect(Object.getOwnPropertyDescriptor(raw()[0], "__proto__")!.value).toEqual({ tag: 1 });
        expect(raw()[0].lorebook[0].content).toBe("edited");
    });
});
