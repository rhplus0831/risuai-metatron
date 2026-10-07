import { derived, get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DetachedWrapperError,
    REMOVE_FIELD,
    applyRawCharacter,
    assignCharacters,
    batchRecordWrites,
    characterData,
    initializeRecords,
    insertCharacterRecord,
    isRecordWrapper,
    moveRecordListItem,
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
import {
    onCharacterSelected,
    selectCharacter,
    selectedCharacterIndex,
    selectedIndex,
    selection,
} from "../selection.svelte";
import { evaluateInDerived } from "./derivedProbe.svelte";
import { assembleChats, findChat } from "../chatStore.svelte";

// Phase 6 slice 5a (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/character-ownership.md`,
// "5a as built" and "After the challenge"): the character list of the production records module and
// the tab's character selection, checked directly. These are the regressions for Astra's challenge
// reproductions and its first re-check (a raw merge after a local reorder or removal, orphaned
// wrappers across a field patch and a whole replacement, a same-id local replacement with a held
// nested wrapper, a repeated object at installation, the reset, the derived-store diamond, the
// selection read inside its listener and a reentrant selection, a removal inside a `$derived`), and
// the contracts the plan review asked for: per-character ownership (a value of A assigned into B is
// a copy), the local-field policy on every trap, the facade's structural refusals with nothing
// changed, and the notification contract (`setCharacterWriteListener`). A refusal is checked for no
// side effect: the raw list text unchanged and no notification.

let notified: string[] = [];

const text = () => JSON.stringify(characterData());
const list = () => trackedCharacters<any[]>()!;
const byId = (chaId: string) => list().find((entry: any) => entry.chaId === chaId);
const raw = (chaId: string) => characterData().find((entry) => entry.chaId === chaId) as any;
const character = (chaId: string, extra: Record<string, unknown> = {}) => ({
    chaId,
    name: chaId.toUpperCase(),
    chats: [{ id: `k${chaId}`, message: [{ role: "user", data: "hi" }], localLore: [] }],
    chatPage: 0,
    ...extra,
});

/**
 * Holds the fixture characters' chats in the chat module the way boot does (Phase 6 slice 9a: the
 * records hold none; a wrapper answers `chats`/`chatPage` from the chat module).
 */
function holdChats(characters: { chaId: string; chats: any[] }[]) {
    assembleChats(
        characters,
        characters.flatMap((entry) =>
            entry.chats.map((chat) => ({ characterId: entry.chaId, id: chat.id, revision: "r1", data: chat })),
        ),
        characters.map((entry) => ({
            characterId: entry.chaId,
            revision: "o1",
            ids: entry.chats.map((chat) => chat.id),
        })),
    );
}

/** Runs `write`, which must throw `errorClass`, and checks that nothing changed and nothing was queued. */
function refused(write: () => unknown, errorClass: new (...args: any[]) => Error = TypeError) {
    const before = text();
    const count = notified.length;
    expect(write).toThrow(errorClass);
    expect(text()).toBe(before);
    expect(notified).toHaveLength(count);
}

beforeEach(() => {
    resetRecords();
    selectCharacter(null);
    notified = [];
    setRecordWriteListener((kind) => notified.push(kind));
    setCharacterWriteListener({
        character: (chaId) => notified.push(`character:${chaId}`),
        membership: () => notified.push("membership"),
    });
});

afterEach(() => {
    resetRecords();
    selectCharacter(null);
});

describe("raw merges and replacements (challenge point 1, re-check 1 point 1)", () => {
    it("a raw scalar patch after a local reorder leaves a retained lore entry on its own entry", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 1 }, { x: 2 }] })] });
        const lore = byId("a").lore;
        const held = lore[0];
        lore.reverse();
        expect(patchRawCharacter("a", [["lastInteraction", 123]])).toBe(true);
        held.x = 9;
        expect(raw("a").lore).toEqual([{ x: 2 }, { x: 9 }]);
        expect(raw("a").lastInteraction).toBe(123);
    });

    it("a raw scalar patch after a local removal leaves the removed entry's wrapper detached", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 1 }, { x: 2 }] })] });
        const lore = byId("a").lore;
        const held = lore[0];
        lore.splice(0, 1);
        patchRawCharacter("a", [["lastInteraction", 123]]);
        notified = [];
        refused(() => (held.x = 9), DetachedWrapperError);
        expect(raw("a").lore).toEqual([{ x: 2 }]);
    });

    it("an orphaned wrapper (moved out of its child map) follows a raw patch of its field by path", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 1 }, { x: 2 }] })] });
        const lore = byId("a").lore;
        const held = lore[0];
        void lore[1];
        lore.reverse();
        void lore[0];
        notified = [];
        patchRawCharacter("a", [["lore", [{ x: 3 }, { x: 4 }]]]);
        expect(notified).toEqual([]);
        expect(() => held.x).not.toThrow();
        expect([3, 4]).toContain(held.x);
        const path = raw("a").lore.findIndex((entry: any) => entry.x === held.x);
        held.x = 7;
        expect(raw("a").lore[path].x).toBe(7);
        expect(notified).toEqual(["character:a"]);
    });

    it("an orphaned wrapper follows a whole same-id replacement by path", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 1 }, { x: 2 }] })] });
        const lore = byId("a").lore;
        const held = lore[0];
        void lore[1];
        lore.reverse();
        void lore[0];
        replaceCharacterRecordAt(0, { chaId: "a", lore: [{ x: 3 }, { x: 4 }] });
        expect(() => held.x).not.toThrow();
        expect([3, 4]).toContain(held.x);
    });

    it("a patch of one field of A keeps the wrappers under A's other fields and under B on their moved entries", () => {
        initializeRecords({
            characters: [character("a", { lore: [{ x: 1 }, { x: 2 }] }), character("b", { lore: [{ x: 1 }] })],
        });
        const heldA = byId("a").lore[0];
        const heldB = byId("b").lore[0];
        byId("a").lore.reverse();
        notified = [];
        patchRawCharacter("a", [["name", "A2"]]);
        patchRawCharacter("b", [["name", "B2"]]);
        heldA.x = 9;
        heldB.x = 8;
        expect(raw("a").lore).toEqual([{ x: 2 }, { x: 9 }]);
        expect(raw("b").lore).toEqual([{ x: 8 }]);
        expect(raw("a").name).toBe("A2");
        // The raw path itself queued nothing; the two writes queued their owners.
        expect(notified).toEqual(["character:a", "character:b"]);
    });

    it("patchRawCharacter deletes a field for REMOVE_FIELD and answers false for an unknown id", () => {
        initializeRecords({ characters: [character("a", { desc: "d" })] });
        expect(patchRawCharacter("a", [["desc", REMOVE_FIELD]])).toBe(true);
        expect("desc" in raw("a")).toBe(false);
        expect(patchRawCharacter("nope", [["desc", "x"]])).toBe(false);
        expect(notified).toEqual([]);
    });
});

describe("same-id local replacement (challenge point 2)", () => {
    it("a held nested wrapper reads and writes the replacement, and the replacement queues its character", () => {
        initializeRecords({ characters: [character("a", { globalLore: [{ content: "old" }] })] });
        const held = byId("a").globalLore[0];
        const chats = raw("a").chats;
        replaceCharacterRecordAt(0, { chaId: "a", globalLore: [{ content: "new" }], chats });
        expect(held.content).toBe("new");
        held.content = "edited";
        expect(raw("a").globalLore).toEqual([{ content: "edited" }]);
        // The same character's chats keep their identity.
        expect(raw("a").chats).toBe(chats);
        expect(notified).toEqual(["membership", "character:a", "character:a"]);
    });

    it("a no-op self-replacement (the record's own wrapper) changes nothing and keeps nested wrappers", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 1 }, { x: 2 }] })] });
        const held = byId("a").lore[0];
        byId("a").lore.reverse();
        const before = characterData()[0];
        replaceCharacterRecordAt(0, byId("a"));
        expect(characterData()[0]).toBe(before);
        held.x = 9;
        expect(raw("a").lore).toEqual([{ x: 2 }, { x: 9 }]);
    });
});

describe("installation and reset (challenge points 3 and 5)", () => {
    it("refuses a list holding one object twice before anything is installed", () => {
        initializeRecords({ ui: { zoomsize: 1 }, characters: [character("a")] });
        const before = text();
        const twice = { chaId: "x", name: "X" };
        expect(() => initializeRecords({ ui: { zoomsize: 2 }, characters: [twice, twice] })).toThrow(TypeError);
        expect(text()).toBe(before);
        expect(recordData<any>("ui")).toEqual({ zoomsize: 1 });
        expect(notified).toEqual([]);
    });

    it("repairs missing, empty, and repeated ids at installation and drops non-objects, with no notification", () => {
        initializeRecords({
            characters: [
                { chaId: "a" },
                { name: "no id" },
                { chaId: "" },
                { chaId: "a", name: "second a" },
                null,
                3,
                [],
            ],
        });
        const ids = characterData().map((entry) => entry.chaId as string);
        expect(ids).toHaveLength(4);
        expect(ids[0]).toBe("a");
        expect(new Set(ids).size).toBe(4);
        for (const id of ids) {
            expect(typeof id === "string" && id.length > 0).toBe(true);
        }
        expect(notified).toEqual([]);
    });

    it("leaves every wrapper made before a reset detached, also against a reinstalled character with the same id", () => {
        initializeRecords({ characters: [character("a", { lore: [{ x: 1 }] })] });
        const element = byId("a");
        const nested = element.lore[0];
        const oldList = list();
        resetRecords();
        setCharacterWriteListener({
            character: (chaId) => notified.push(`character:${chaId}`),
            membership: () => notified.push("membership"),
        });
        initializeRecords({ characters: [character("a", { lore: [{ x: 5 }] })] });
        notified = [];
        refused(() => (element.name = "through an old wrapper"), DetachedWrapperError);
        refused(() => (nested.x = 9), DetachedWrapperError);
        expect(() => oldList[0]).toThrow(DetachedWrapperError);
        expect(raw("a").lore).toEqual([{ x: 5 }]);
        expect(raw("a").name).toBe("A");
    });
});

describe("ownership across characters (plan review point 1)", () => {
    it("stores a value of A assigned into B as a copy; edits stay with their owner and queue only it", () => {
        initializeRecords({
            characters: [character("a", { globalLore: [{ content: "a1" }] }), character("b", { globalLore: [] })],
            ui: { scheme: { color: "red" } },
        });
        const a = byId("a");
        const b = byId("b");
        b.globalLore = a.globalLore;
        b.firstEntry = a.globalLore[0];
        b.fromRaw = raw("a").globalLore;
        b.fromSettings = trackedRecord<any>("ui")!.scheme;
        expect(notified).toEqual(["character:b", "character:b", "character:b", "character:b"]);
        expect(raw("b").globalLore).not.toBe(raw("a").globalLore);
        expect(raw("b").fromRaw).not.toBe(raw("a").globalLore);
        expect(isRecordWrapper(raw("b").globalLore)).toBe(false);

        notified = [];
        a.globalLore[0].content = "a edited";
        expect(notified).toEqual(["character:a"]);
        expect(raw("b").globalLore).toEqual([{ content: "a1" }]);
        expect(raw("b").firstEntry).toEqual({ content: "a1" });
        expect(raw("b").fromRaw).toEqual([{ content: "a1" }]);

        notified = [];
        b.globalLore[0].content = "b edited";
        b.fromSettings.color = "blue";
        expect(notified).toEqual(["character:b", "character:b"]);
        expect(raw("a").globalLore).toEqual([{ content: "a edited" }]);
        expect(recordData<any>("ui").scheme).toEqual({ color: "red" });
    });

    it("keeps identity within one character (a retained wrapper of A assigned back into A is the same object)", () => {
        initializeRecords({ characters: [character("a", { globalLore: [{ content: "1" }, { content: "2" }] })] });
        const a = byId("a");
        const second = raw("a").globalLore[1];
        a.globalLore = [a.globalLore[1], a.globalLore[0]];
        expect(raw("a").globalLore[0]).toBe(second);
    });
});

describe("the local fields (plan review point 3)", () => {
    it("reads chats, chatPage, and reloadKeys raw through every trap, and writes them raw with no notification", () => {
        initializeRecords({ characters: [character("a", { reloadKeys: 0 })] });
        holdChats([character("a")]);
        const a = byId("a");
        // Phase 6 slice 9a: the record holds no chats; the wrapper answers them from the chat module.
        expect(raw("a").chats).toBeUndefined();
        expect(raw("a").chatPage).toBeUndefined();
        const held = findChat({ chaId: "a", chatId: "ka" });
        expect(a.chats).toEqual([held]);
        expect(a.chats[0]).toBe(held);
        expect(a.chatPage).toBe(0);
        expect(isRecordWrapper(a.chats)).toBe(false);
        expect(isRecordWrapper(a.chats[0])).toBe(false);
        expect(Object.getOwnPropertyDescriptor(a, "chats")).toBeUndefined();

        // Writing, defining, or deleting a chat field is refused, with nothing changed.
        refused(() => (a.chats = []));
        refused(() => (a.chatPage = 1));
        refused(() =>
            Object.defineProperty(a, "chatPage", { value: 0, writable: true, enumerable: true, configurable: true }),
        );
        refused(() => delete a.chats);
        a.reloadKeys += 1;
        Object.defineProperty(a, "reloadKeys", { value: 0, writable: true, enumerable: true, configurable: true });
        delete a.reloadKeys;
        a.reloadKeys = 5;
        expect(notified).toEqual([]);
        expect(findChat({ chaId: "a", chatId: "ka" })).toBe(held);
        expect(held!.message.map((entry: any) => entry.data)).toEqual(["hi"]);
        expect(raw("a").reloadKeys).toBe(5);
    });

    it("stores a wrapper assigned into a local field as a detached copy", () => {
        initializeRecords({ characters: [character("a", { globalLore: [{ content: "1" }] })] });
        const a = byId("a");
        a.reloadKeys = a.globalLore;
        expect(notified).toEqual([]);
        expect(isRecordWrapper(raw("a").reloadKeys)).toBe(false);
        a.globalLore[0].content = "2";
        expect(raw("a").reloadKeys).toEqual([{ content: "1" }]);
    });

    it("keeps the same character's chats by identity across a same-id replacement and a raw server copy", () => {
        initializeRecords({ characters: [character("a", { reloadKeys: 3 })] });
        holdChats([character("a")]);
        const chats = byId("a").chats;
        const held = findChat({ chaId: "a", chatId: "ka" });
        replaceCharacterRecordAt(0, { chaId: "a", name: "replaced", chats, chatPage: 0 });
        expect(byId("a").chats).toEqual(chats);
        expect(findChat({ chaId: "a", chatId: "ka" })).toBe(held);
        applyRawCharacter("a", { chaId: "a", name: "server" });
        expect(byId("a").chats).toEqual(chats);
        expect(findChat({ chaId: "a", chatId: "ka" })).toBe(held);
        expect(byId("a").chatPage).toBe(0);
        expect(raw("a").chats).toBeUndefined();
        expect(raw("a").name).toBe("server");
    });

    it("copies another character's live chats when a whole character is stored with them", () => {
        initializeRecords({ characters: [character("a")] });
        holdChats([character("a")]);
        const chats = byId("a").chats;
        insertCharacterRecord({ chaId: "b", name: "B", chats, chatPage: 0 });
        // Phase 6 slice 9a: the record drops them; b holds no chats until the chat module installs some.
        expect(raw("b").chats).toBeUndefined();
        expect(byId("b").chats).toEqual([]);
        expect(byId("a").chats).toEqual(chats);
        expect(findChat({ chaId: "a", chatId: "ka" })!.message).toHaveLength(1);
    });

    it("appends a server copy of a character the list lacks with empty chats, and removes one for null", () => {
        initializeRecords({ characters: [character("a")] });
        holdChats([character("a")]);
        applyRawCharacter("n", { chaId: "n", name: "N", chats: [{ id: "ignored" }] });
        expect(raw("n")).toEqual({ chaId: "n", name: "N" });
        expect(byId("n").chats).toEqual([]);
        // The facade's `chatPage` is the selected chat's index among the loaded chats, -1 with none
        // (Phase 6 slice 9b).
        expect(byId("n").chatPage).toBe(-1);
        applyRawCharacter("n", null);
        expect(raw("n")).toBeUndefined();
        expect(notified).toEqual([]);
    });
});

describe("structural writes through the facade (plan review point 7) and the immutable chaId (point 9)", () => {
    it("refuses every list mutator, index and length writes, delete, defineProperty, and list assignment, with nothing changed", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const characters = list();
        const other = { chaId: "z", name: "Z" };
        for (const write of [
            () => characters.push(other),
            () => characters.pop(),
            () => characters.shift(),
            () => characters.unshift(other),
            () => characters.splice(0, 1),
            () => characters.sort(),
            () => characters.reverse(),
            () => characters.fill(other),
            () => characters.copyWithin(0, 1),
            () => (characters[0] = other),
            () => (characters[0] = characters[1]),
            () => (characters[2] = other),
            () => (characters.length = 0),
            () => delete characters[0],
            () =>
                Object.defineProperty(characters, "0", {
                    value: other,
                    writable: true,
                    enumerable: true,
                    configurable: true,
                }),
            () => assignCharacters([other]),
            () => assignCharacters([...characterData()]),
            () => moveRecordListItem(characters, 0, 1),
            () => replaceRecordList(characters, [characters[1], characters[0]]),
        ]) {
            refused(write);
        }
    });

    it("accepts the no-op self-assignments (the Svelte 3 pattern) and queues nothing", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const characters = list();
        characters[0] = characters[0];
        characters[1] = characterData()[1] as any;
        characters.length = 2;
        assignCharacters(characters);
        assignCharacters(characterData());
        expect(notified).toEqual([]);
        expect(characterData().map((entry) => entry.chaId)).toEqual(["a", "b"]);
    });

    it("refuses a changed chaId by assignment, delete, and defineProperty, and takes a same-value assignment as a no-op", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const a = byId("a");
        refused(() => (a.chaId = "b"));
        refused(() => (a.chaId = "new"));
        refused(() => delete a.chaId);
        refused(() =>
            Object.defineProperty(a, "chaId", { value: "new", writable: true, enumerable: true, configurable: true }),
        );
        a.chaId = "a";
        expect(notified).toEqual([]);
        expect(raw("a")).toBeDefined();
    });

    it("refuses an insertion or a replacement with a missing or taken chaId before anything changes", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        refused(() => insertCharacterRecord({ name: "no id" }));
        refused(() => insertCharacterRecord({ chaId: "", name: "empty" }));
        refused(() => insertCharacterRecord({ chaId: "a", name: "taken" }));
        refused(() => replaceCharacterRecordAt(0, { chaId: "b", name: "taken elsewhere" }));
        refused(() => replaceCharacterRecordAt(5, { chaId: "c" }));
        refused(() => replaceCharacterRecordAt(0, [] as any));
    });
});

describe("notifications (setCharacterWriteListener)", () => {
    it("queues the owner of a write at any depth, once per nested mutator, and coalesces in a batch", () => {
        initializeRecords({ characters: [character("a", { lore: [{ keys: ["k"] }] }), character("b")] });
        byId("a").name = "A2";
        byId("a").lore[0].keys.push("k2", "k3");
        byId("a").lore.splice(0, 0, { keys: [] }, { keys: [] });
        expect(notified).toEqual(["character:a", "character:a", "character:a"]);
        notified = [];
        batchRecordWrites(() => {
            byId("a").name = "A3";
            byId("b").name = "B3";
            byId("a").desc = "d";
        });
        expect(notified.sort()).toEqual(["character:a", "character:b"]);
    });

    it("queues the membership and the stored id for an insertion and a replacement, the membership alone for a removal, and nothing for the raw path", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        expect(insertCharacterRecord({ chaId: "c", name: "C" })).toBe(2);
        expect(notified).toEqual(["membership", "character:c"]);
        notified = [];
        replaceCharacterRecordAt(1, { chaId: "d", name: "D" });
        expect(notified).toEqual(["membership", "character:d"]);
        notified = [];
        expect(removeCharacterRecords(["a", "missing", "c"])).toEqual(["a", "c"]);
        expect(notified).toEqual(["membership"]);
        expect(characterData().map((entry) => entry.chaId)).toEqual(["d"]);
        notified = [];
        applyRawCharacter("d", { chaId: "d", name: "server" });
        applyRawCharacter("e", { chaId: "e", name: "E" });
        patchRawCharacter("e", [["name", "E2"]]);
        applyRawCharacter("e", null);
        expect(notified).toEqual([]);
    });
});

describe("the selection (plan review points 4 and 5)", () => {
    it("publishes the index synchronously after every membership change, local or raw, and follows its character", () => {
        initializeRecords({ characters: [character("a"), character("b"), character("c")] });
        const seen: number[] = [];
        const unsubscribe = selectedCharacterIndex.subscribe((value) => seen.push(value));
        selectedCharacterIndex.set(2);
        expect(selection.characterId).toBe("c");
        expect(get(selectedCharacterIndex)).toBe(2);
        expect(selectedIndex()).toBe(2);

        removeCharacterRecords(["a"]);
        expect(get(selectedCharacterIndex)).toBe(1);
        expect(selectedIndex()).toBe(1);
        insertCharacterRecord({ chaId: "d", name: "D" });
        expect(get(selectedCharacterIndex)).toBe(1);
        applyRawCharacter("b", null);
        expect(get(selectedCharacterIndex)).toBe(0);
        expect(selectedIndex()).toBe(0);
        applyRawCharacter("c", { chaId: "c", name: "server" });
        expect(get(selectedCharacterIndex)).toBe(0);
        expect(seen).toEqual([-1, 2, 1, 0]);

        selectedCharacterIndex.update((index) => index + 1);
        expect(selection.characterId).toBe("d");
        selectedCharacterIndex.set(-1);
        expect(selection.characterId).toBeNull();
        selectedCharacterIndex.set(7);
        expect(selection.characterId).toBeNull();
        selectCharacter("missing");
        expect(selection.characterId).toBeNull();
        unsubscribe();
    });

    it("selects home when the selected character leaves by removal, a same-index different-id replacement, a raw delete, or a reinstall, and stays home on reinsertion", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        for (const leave of [
            () => removeCharacterRecords(["a"]),
            () => replaceCharacterRecordAt(0, { chaId: "z", name: "Z" }),
            () => applyRawCharacter("a", null),
            () => initializeRecords({ characters: [character("b")] }),
            () => resetRecords(),
        ]) {
            initializeRecords({ characters: [character("a"), character("b")] });
            selectCharacter("a");
            expect(get(selectedCharacterIndex)).toBe(0);
            leave();
            expect(selection.characterId).toBeNull();
            expect(get(selectedCharacterIndex)).toBe(-1);
            expect(selectedIndex()).toBe(-1);
        }
        initializeRecords({ characters: [character("a"), character("b")] });
        selectCharacter("a");
        removeCharacterRecords(["a"]);
        insertCharacterRecord({ chaId: "a", name: "A again" });
        expect(selection.characterId).toBeNull();
        expect(get(selectedCharacterIndex)).toBe(-1);
    });

    it("keeps the selection across a same-id replacement and a raw same-id copy", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        selectCharacter("b");
        replaceCharacterRecordAt(1, { chaId: "b", name: "B2" });
        applyRawCharacter("b", { chaId: "b", name: "B3" });
        expect(selection.characterId).toBe("b");
        expect(get(selectedCharacterIndex)).toBe(1);
    });

    it("keeps derived stores consistent (the diamond: no mixed old and new values)", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const left = derived(selectedCharacterIndex, (index) => index * 2);
        const right = derived(selectedCharacterIndex, (index) => index * 3);
        const both = derived([left, right], ([l, r]) => [l, r]);
        const seen: number[][] = [];
        const unsubscribe = both.subscribe((value) => seen.push(value));
        selectedCharacterIndex.set(1);
        removeCharacterRecords(["a"]);
        unsubscribe();
        for (const [l, r] of seen) {
            expect(l / 2).toBe(r / 3);
        }
        expect(seen.at(-1)).toEqual([0, 0]);
    });

    it("lets a selection listener read the new selection everywhere, and skips one superseded by a reentrant selection", () => {
        initializeRecords({ characters: [character("a"), character("b"), character("c")] });
        const reads: unknown[] = [];
        const offRead = onCharacterSelected((chaId) =>
            reads.push([chaId, selection.characterId, selectedIndex(), get(selectedCharacterIndex)]),
        );
        selectCharacter("b");
        expect(reads).toEqual([["b", "b", 1, 1]]);
        // Selecting the same character again is no news.
        selectCharacter("b");
        expect(reads).toHaveLength(1);
        offRead();

        const heard: string[] = [];
        const offHeard = onCharacterSelected((chaId) => heard.push(chaId));
        let redirected = false;
        const unsubscribe = selectedCharacterIndex.subscribe((index) => {
            if (index === 0 && !redirected) {
                redirected = true;
                selectCharacter("c");
            }
        });
        selectCharacter("a");
        expect(heard).toEqual(["c"]);
        expect(selection.characterId).toBe("c");
        expect(get(selectedCharacterIndex)).toBe(2);
        unsubscribe();
        offHeard();

        // A listener that selects again: the later listeners hear only the newer selection.
        const order: string[] = [];
        const offFirst = onCharacterSelected((chaId) => {
            order.push(`first:${chaId}`);
            if (chaId === "a") {
                selectCharacter("b");
            }
        });
        const offSecond = onCharacterSelected((chaId) => order.push(`second:${chaId}`));
        selectCharacter("a");
        expect(order).toEqual(["first:a", "first:b", "second:b"]);
        expect(get(selectedCharacterIndex)).toBe(1);
        offFirst();
        offSecond();
    });

    it("tells the listeners of a tab's selection only, not of home or of a reconciliation", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        const heard: string[] = [];
        const off = onCharacterSelected((chaId) => heard.push(chaId));
        selectCharacter("a");
        removeCharacterRecords(["a"]);
        selectCharacter(null);
        applyRawCharacter("n", { chaId: "n" });
        expect(heard).toEqual(["a"]);
        off();
    });

    it("completes a removal made inside a $derived, with the selection reconciled to home (re-check 1 point 3)", () => {
        initializeRecords({ characters: [character("a"), character("b")] });
        selectCharacter("a");
        const removed = evaluateInDerived(() => removeCharacterRecords(["a"]));
        expect(removed).toEqual(["a"]);
        expect(characterData().map((entry) => entry.chaId)).toEqual(["b"]);
        expect(selection.characterId).toBeNull();
        expect(get(selectedCharacterIndex)).toBe(-1);
    });
});
