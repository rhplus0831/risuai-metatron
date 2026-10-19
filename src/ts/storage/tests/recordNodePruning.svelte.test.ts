import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DetachedWrapperError,
    applyRaw,
    applyRawCharacter,
    characterData,
    characterFieldStamp,
    initializeRecords,
    insertCharacterRecord,
    patchRawCharacter,
    recordData,
    removeCharacterRecords,
    replaceCharacterRecordAt,
    replaceRecordList,
    resetRecords,
    setCharacterWriteListener,
    setRecordWriteListener,
    trackedCharacters,
    trackedRecord,
} from "../records.svelte";

// Heap plan D1 (`docs/plan/heap-memory.md`): the record wrapper nodes no longer keep removed data.
// These are the behavioral contracts of that change (the retention itself is proved by the heap
// driver, `util/playwright/measureHeap.mjs`, and its retainer analysis, not here): a retained wrapper
// of a character that left the list through any of the four membership paths throws while the id is
// absent and follows a same-id re-add (as another object than the fresh wrapper, stamping the same
// meta); a retained nested wrapper under a raw change (`applyRawCharacter`, `patchRawCharacter`,
// `applyRaw`, a reinstallation) follows by path, stays one object with a fresh read, and its writes
// reach the save cache's stamps; a local shrink (a mutator, a direct `length` write,
// `replaceRecordList`) keeps the survivors' identity; the reviewer's challenge reproductions (a raw
// change inside a comparator, a same-task displaced re-insertion after a raw change, a truncation of
// another list inside a comparator, an effect teardown's reads of a shrunk root list before the
// deferred trim of its original array); and both orders of a raw regrowth after a prune.

let notified: string[] = [];

const list = () => trackedCharacters<any[]>()!;
const byId = (chaId: string) => list().find((entry: any) => entry.chaId === chaId);
const raw = (chaId: string) => characterData().find((entry) => entry.chaId === chaId) as any;
const rawText = () => JSON.stringify(characterData());
const character = (chaId: string, extra: Record<string, unknown> = {}) => ({
    chaId,
    name: chaId.toUpperCase(),
    lore: [{ x: 1 }, { x: 2 }],
    ...extra,
});
const modules = () => trackedRecord<any[]>("modules")!;
const moduleIds = () => (recordData<any[]>("modules") ?? []).map((entry) => entry.id);

beforeEach(() => {
    resetRecords();
    notified = [];
    setRecordWriteListener((kind) => notified.push(kind));
    setCharacterWriteListener({
        character: (chaId) => notified.push(`character:${chaId}`),
        membership: () => notified.push("membership"),
    });
});

afterEach(() => {
    resetRecords();
});

/**
 * A retained wrapper of character `a` (its element and a lore entry) across `remove`, which takes
 * `a` out of the list: both throw while the id is absent, and after a same-id re-add the element
 * wrapper reads the new data and writes it; the re-added character's fresh wrapper is another object
 * (the canonical node was dropped), and both stamp the same character. With `nestedFollows`, the
 * retained lore entry follows the re-add by path too (the paths that bump the character's epoch).
 */
function detachedAndReadded(remove: () => void, nestedFollows = true) {
    initializeRecords({ characters: [character("a"), character("b")] });
    const element = byId("a");
    const entry = element.lore[0];
    const freshBefore = byId("a");
    expect(freshBefore).toBe(element);
    remove();
    expect(characterData().map((entry) => entry.chaId)).toEqual(["b"]);
    expect(() => element.name).toThrow(DetachedWrapperError);
    expect(() => entry.x).toThrow(DetachedWrapperError);
    expect(() => (entry.x = 9)).toThrow(DetachedWrapperError);
    expect(byId("a")).toBeUndefined();
    notified = [];
    insertCharacterRecord({ chaId: "a", name: "A2", lore: [{ x: 5 }] });
    const stampBefore = characterFieldStamp("a", "lore");
    expect(element.name).toBe("A2");
    const fresh = byId("a");
    expect(fresh).not.toBe(element);
    expect(fresh.name).toBe("A2");
    if (nestedFollows) {
        expect(entry.x).toBe(5);
        entry.x = 7;
    } else {
        expect(() => entry.x).toThrow(DetachedWrapperError);
        element.lore[0].x = 7;
    }
    expect(raw("a").lore).toEqual([{ x: 7 }]);
    expect(fresh.lore[0].x).toBe(7);
    expect(characterFieldStamp("a", "lore")).not.toBe(stampBefore);
    expect(notified).toEqual(["membership", "character:a", "character:a"]);
    element.name = "A3";
    expect(raw("a").name).toBe("A3");
    expect(fresh.name).toBe("A3");
}

describe("a character leaving the list (D1: its canonical node is dropped)", () => {
    it("removeCharacterRecords: the retained wrappers throw, then follow a same-id re-add", () => {
        detachedAndReadded(() => {
            expect(removeCharacterRecords(["a"])).toEqual(["a"]);
        });
    });

    it("applyRawCharacter(id, null): the same", () => {
        detachedAndReadded(() => applyRawCharacter("a", null));
    });

    it("replaceCharacterRecordAt with another id: the character that was there left", () => {
        // Pre-existing (not D1): this path bumps no epoch of the leaving character, so its retained
        // nested wrappers resolve by identity after a same-id re-add and throw; the element follows.
        detachedAndReadded(() => {
            replaceCharacterRecordAt(0, { chaId: "c", name: "C" });
            expect(removeCharacterRecords(["c"])).toEqual(["c"]);
        }, false);
    });

    it("initializeRecords without the character: the same, and the kept character's wrappers stay canonical", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const heldB = byId("b");
        const heldBEntry = heldB.lore[1];
        detachedAndReadded(() => initializeRecords({ characters: [character("b", { lore: [{ x: 3 }, { x: 4 }] })] }));
        // The reinstalled `b`: its retained wrappers follow the new data by path and are the fresh ones.
        expect(byId("b")).toBe(heldB);
        expect(heldBEntry.x).toBe(4);
        expect(byId("b").lore[1]).toBe(heldBEntry);
        heldBEntry.x = 8;
        expect(raw("b").lore).toEqual([{ x: 3 }, { x: 8 }]);
    });

    it("the retained wrapper of a character replaced in place by another id follows that id, not the slot", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const heldA = byId("a");
        replaceCharacterRecordAt(0, { chaId: "c", name: "C" });
        expect(characterData().map((entry) => entry.chaId)).toEqual(["c", "b"]);
        expect(() => heldA.name).toThrow(DetachedWrapperError);
        expect(byId("c").name).toBe("C");
    });
});

describe("raw changes under a retained wrapper (D1: cached nodes let go of the old data, keep their paths)", () => {
    it("a same-id server copy: a retained nested wrapper reads the copy, is the fresh wrapper, and its write stamps the field", () => {
        initializeRecords({ characters: [character("a")] });
        const element = byId("a");
        const entry = element.lore[0];
        const lore = element.lore;
        applyRawCharacter("a", { chaId: "a", name: "A2", lore: [{ x: 10 }, { x: 20 }] });
        const stampBefore = characterFieldStamp("a", "lore");
        expect(notified).toEqual([]);
        expect(entry.x).toBe(10);
        expect(byId("a")).toBe(element);
        expect(byId("a").lore).toBe(lore);
        expect(byId("a").lore[0]).toBe(entry);
        entry.x = 11;
        expect(raw("a").lore).toEqual([{ x: 11 }, { x: 20 }]);
        expect(characterFieldStamp("a", "lore")).not.toBe(stampBefore);
        expect(characterFieldStamp("a", "name")).toBe(characterFieldStamp("a", "name"));
        expect(notified).toEqual(["character:a"]);
    });

    it("a raw patch of one field: the retained wrappers under it follow, the others keep their objects", () => {
        initializeRecords({ characters: [character("a", { other: [{ y: 1 }] })] });
        const entry = byId("a").lore[0];
        const other = byId("a").other[0];
        byId("a").other.reverse();
        const nameStamp = characterFieldStamp("a", "name");
        patchRawCharacter("a", [["lore", [{ x: 30 }]]]);
        expect(entry.x).toBe(30);
        expect(byId("a").lore[0]).toBe(entry);
        expect(other.y).toBe(1);
        expect(characterFieldStamp("a", "name")).toBe(nameStamp);
        const loreStamp = characterFieldStamp("a", "lore");
        entry.x = 31;
        expect(raw("a").lore).toEqual([{ x: 31 }]);
        expect(characterFieldStamp("a", "lore")).not.toBe(loreStamp);
    });

    it("a shorter server copy of a root list: a kept index's retained wrapper follows by path and is the fresh one, the tail's throws", () => {
        initializeRecords({ modules: [{ id: "a", lorebook: [{ key: "k" }] }, { id: "b" }, { id: "c" }] });
        const first = modules()[0];
        const heldEntry = first.lorebook[0];
        const last = modules()[2];
        applyRaw("modules", [{ id: "x", lorebook: [{ key: "k2" }] }, { id: "y" }]);
        expect(first.id).toBe("x");
        expect(modules()[0]).toBe(first);
        expect(heldEntry.key).toBe("k2");
        expect(modules()[0].lorebook[0]).toBe(heldEntry);
        expect(() => last.id).toThrow(DetachedWrapperError);
        notified = [];
        heldEntry.key = "k3";
        expect(recordData<any[]>("modules")![0].lorebook).toEqual([{ key: "k3" }]);
        expect(notified).toEqual(["modules"]);
    });

    it("a record removed by a server copy and put back: the retained root wrapper throws in between and works after", () => {
        initializeRecords({ modules: [{ id: "a" }] });
        const root = modules();
        const held = root[0];
        applyRaw("modules", undefined);
        expect(() => root.length).toThrow(DetachedWrapperError);
        expect(() => held.id).toThrow(DetachedWrapperError);
        applyRaw("modules", [{ id: "z" }]);
        expect(root.length).toBe(1);
        expect(held.id).toBe("z");
        expect(modules()[0]).toBe(held);
    });
});

describe("local shrinks (D1: the index tail is pruned, survivors keep their identity)", () => {
    it("a nested list's splice: the survivor's retained wrapper is the fresh one, the removed one's throws", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 1 }, { x: 2 }, { x: 3 }] })] });
        const lore = byId("a").lore;
        const [first, second, third] = [lore[0], lore[1], lore[2]];
        lore.splice(0, 1);
        expect(() => first.x).toThrow(DetachedWrapperError);
        expect(lore[0]).toBe(second);
        expect(lore[1]).toBe(third);
        expect(third.x).toBe(3);
        third.x = 33;
        expect(raw("a").lore).toEqual([{ x: 2 }, { x: 33 }]);
    });

    it("a root list's pop and shift: the survivors keep their wrappers, the record is written once each", () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }, { id: "c" }] });
        const [a, b, c] = [modules()[0], modules()[1], modules()[2]];
        // A mutator hands back the removed element's wrapper, which is detached from then on.
        expect(modules().pop()).toBe(c);
        expect(() => c.id).toThrow(DetachedWrapperError);
        expect(modules().shift()).toBe(a);
        expect(() => a.id).toThrow(DetachedWrapperError);
        expect(modules()[0]).toBe(b);
        expect(moduleIds()).toEqual(["b"]);
        expect(notified).toEqual(["modules", "modules"]);
    });

    it("a direct length write truncates, the dropped wrappers throw, the kept one stays", () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }, { id: "c" }] });
        const [a, b, c] = [modules()[0], modules()[1], modules()[2]];
        modules().length = 1;
        expect(moduleIds()).toEqual(["a"]);
        expect(modules()[0]).toBe(a);
        expect(() => b.id).toThrow(DetachedWrapperError);
        expect(() => c.id).toThrow(DetachedWrapperError);
        expect(notified).toEqual(["modules"]);
        // A no-op and a growing length write change nothing of that.
        modules().length = 1;
        modules().length = 2;
        expect(modules()[0]).toBe(a);
        expect(modules().length).toBe(2);
    });

    it("replaceRecordList shrinking a root list: the kept element's wrapper stays, the dropped one's throws after the task", async () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }] });
        const [a, b] = [modules()[0], modules()[1]];
        replaceRecordList(modules(), [a]);
        expect(moduleIds()).toEqual(["a"]);
        expect(modules()[0]).toBe(a);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(() => b.id).toThrow(DetachedWrapperError);
    });

    it("a mutator whose comparator throws leaves the error as it is and the list usable", () => {
        initializeRecords({
            modules: [
                { id: "a", n: 2 },
                { id: "b", n: 1 },
            ],
        });
        const held = modules()[0];
        expect(() =>
            modules().sort(() => {
                throw new Error("boom");
            }),
        ).toThrow("boom");
        expect(held.id).toBe("a");
        const second = modules()[1];
        expect(modules().pop()).toBe(second);
        expect(moduleIds()).toEqual(["a"]);
    });
});

describe("the challenge's reproductions", () => {
    it("a server copy inside a sort comparator: the mutator still writes back the objects it read", () => {
        initializeRecords({
            modules: [
                { id: "b", n: 2 },
                { id: "a", n: 1 },
            ],
        });
        let applied = false;
        modules().sort((x: any, y: any) => {
            const order = x.n - y.n;
            if (!applied) {
                applied = true;
                applyRaw("modules", [
                    { id: "x", n: 10 },
                    { id: "y", n: 20 },
                ]);
            }
            return order;
        });
        expect(applied).toBe(true);
        expect(moduleIds()).toEqual(["a", "b"]);
    });

    it("a server copy inside a character lore sort: the same for a character's own list", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 2 }, { x: 1 }] })] });
        let applied = false;
        byId("a").lore.sort((p: any, q: any) => {
            const order = p.x - q.x;
            if (!applied) {
                applied = true;
                applyRawCharacter("a", { chaId: "a", name: "A2", lore: [{ x: 50 }, { x: 60 }] });
            }
            return order;
        });
        expect(raw("a").lore).toEqual([{ x: 1 }, { x: 2 }]);
        expect(raw("a").name).toBe("A2");
    });

    it("a removed element's wrapper is re-inserted in the same task after a server copy emptied the list", () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }] });
        const held = modules()[0];
        modules().splice(0, 1);
        applyRaw("modules", []);
        modules().push(held);
        expect(moduleIds()).toEqual(["a"]);
        expect(held.id).toBe("a");
        expect(modules()[0]).toBe(held);
    });

    it("a truncation of another list inside a comparator behaves as one outside it", () => {
        const run = (truncate: (cut: () => void) => void) => {
            resetRecords();
            initializeRecords({
                ui: { sorter: [2, 1] },
                modules: [{ id: "a" }, { id: "b" }],
            });
            const [a, b] = [modules()[0], modules()[1]];
            truncate(() => {
                modules().length = 0;
            });
            expect(moduleIds()).toEqual([]);
            expect(() => a.id).toThrow(DetachedWrapperError);
            expect(() => b.id).toThrow(DetachedWrapperError);
            // A raw regrowth read fresh first: whether the dropped wrappers come back as the fresh
            // ones is the same either way (the comparator path pruned what the direct path prunes).
            applyRaw("modules", [{ id: "x" }, { id: "y" }]);
            const fresh = [modules()[0], modules()[1]];
            expect(a.id).toBe("x");
            expect(b.id).toBe("y");
            return [Object.is(fresh[0], a), Object.is(fresh[1], b)];
        };
        const inside = run((cut) => {
            trackedRecord<any>("ui")!.sorter.sort((p: number, q: number) => {
                cut();
                return p - q;
            });
            expect(recordData<any>("ui").sorter).toEqual([1, 2]);
        });
        const outside = run((cut) => cut());
        expect(inside).toEqual(outside);
    });

    it("an effect's teardown reads the root list as it was; the original array is trimmed after the tick", async () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const seen: { length: number; hasSecond: boolean; ids: unknown[] }[] = [];
        let runs = 0;
        const dispose = $effect.root(() => {
            $effect(() => {
                const data = characterData();
                runs += 1;
                void data[0];
                void data[1];
                void data.length;
                return () => {
                    seen.push({ length: data.length, hasSecond: 1 in data, ids: data.map((entry) => entry.chaId) });
                };
            });
        });
        flushSync();
        expect(runs).toBe(1);
        try {
            removeCharacterRecords(["b"]);
            flushSync();
            expect(runs).toBe(2);
            // The teardown of the first run saw the list before the removal, consistently.
            expect(seen).toEqual([{ length: 2, hasSecond: true, ids: ["a", "b"] }]);
            // Outside a teardown the live list already reads short.
            expect(characterData().length).toBe(1);
            expect(1 in characterData()).toBe(false);
            await tick();
            // The original array is trimmed: no trace of the removed element through any trap.
            const data = characterData();
            expect(data.length).toBe(1);
            expect(1 in data).toBe(false);
            expect(Object.keys(data)).toEqual(["0"]);
            expect(data.map((entry) => entry.chaId)).toEqual(["a"]);
            expect(JSON.parse(JSON.stringify(data)).map((entry: any) => entry.chaId)).toEqual(["a"]);
            // The list is still the same object, and still written through.
            expect(byId("a").lore[0]).toBeDefined();
            byId("a").name = "A2";
            expect(raw("a").name).toBe("A2");
            insertCharacterRecord({ chaId: "c", name: "C" });
            expect(characterData().map((entry) => entry.chaId)).toEqual(["a", "c"]);
            expect(1 in characterData()).toBe(true);
        } finally {
            dispose();
        }
    });

    it("the trim after a tick keeps a character re-added before it", async () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        removeCharacterRecords(["b"]);
        insertCharacterRecord({ chaId: "b", name: "B2" });
        insertCharacterRecord({ chaId: "c", name: "C" });
        await tick();
        const data = characterData();
        expect(data.map((entry) => entry.chaId)).toEqual(["a", "b", "c"]);
        expect(Object.keys(data)).toEqual(["0", "1", "2"]);
        expect(byId("b").name).toBe("B2");
        byId("b").name = "B3";
        expect(raw("b").name).toBe("B3");
    });
});

describe("raw regrowth after a prune (both orders)", () => {
    it("modules, retained first: the dropped wrapper follows by path and the fresh read is the same object", () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }] });
        const held = modules()[1];
        modules().pop();
        expect(() => held.id).toThrow(DetachedWrapperError);
        applyRaw("modules", [{ id: "a" }, { id: "y" }]);
        expect(held.id).toBe("y");
        expect(modules()[1]).toBe(held);
        held.name = "Y";
        expect(recordData<any[]>("modules")![1]).toEqual({ id: "y", name: "Y" });
    });

    it("modules, fresh first: both the fresh and the dropped wrapper read and write the element there", () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }] });
        const held = modules()[1];
        modules().pop();
        applyRaw("modules", [{ id: "a" }, { id: "y" }]);
        const fresh = modules()[1];
        expect(fresh.id).toBe("y");
        expect(held.id).toBe("y");
        held.name = "Y";
        expect(fresh.name).toBe("Y");
        fresh.name = "Y2";
        expect(held.name).toBe("Y2");
        expect(recordData<any[]>("modules")![1]).toEqual({ id: "y", name: "Y2" });
    });

    it("a character's lore, retained first: a raw patch regrows the list and the dropped wrapper follows by path", () => {
        initializeRecords({ characters: [character("a")] });
        const held = byId("a").lore[1];
        byId("a").lore.pop();
        expect(() => held.x).toThrow(DetachedWrapperError);
        patchRawCharacter("a", [["lore", [{ x: 7 }, { x: 8 }]]]);
        expect(held.x).toBe(8);
        expect(byId("a").lore[1]).toBe(held);
        held.x = 9;
        expect(raw("a").lore).toEqual([{ x: 7 }, { x: 9 }]);
    });

    it("a character's lore, fresh first: both wrappers write the element there", () => {
        initializeRecords({ characters: [character("a")] });
        const held = byId("a").lore[1];
        byId("a").lore.pop();
        patchRawCharacter("a", [["lore", [{ x: 7 }, { x: 8 }]]]);
        const fresh = byId("a").lore[1];
        expect(fresh.x).toBe(8);
        expect(held.x).toBe(8);
        held.x = 9;
        expect(fresh.x).toBe(9);
        expect(raw("a").lore).toEqual([{ x: 7 }, { x: 9 }]);
    });
});
