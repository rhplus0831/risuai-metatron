import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "src/ts/storage/tests/mutationStoresHarness";
import type { RPCToolCallContent } from "../../mcplib";

// Phase 4, slice 4 (`mcp-risuaccess-writers`): the RisuAccess character tools (`characters.ts`)
// against the real save adapter and the real server store (`storeBackedServer.ts`). Every write
// tool on a character that is not selected lands by `chaId` through `updateCharacter` and is sent
// by the next cycle; a refused consent, a missing entry, a refused patch, and a request with one
// bad field change nothing and mark nothing (no batch after a flush). The consent gate: the write
// is built from the record as it is after consent (a list replaced while the prompt was open), the
// captured id stays the target through a rename and a selection change, and a character removed
// or turned into a group while the prompt was open answers an error without a write. The read
// tools' output is pinned, including an empty `globalLore`. Since Phase 6 slice 5b every character
// carries the shared defaults (the server normalizes the seeded `c`, `addCharacter` prepares the
// others): `globalLore` is `[]`, `desc` is `""`, and `type` is `"character"` unless set.

const { server, alerts, consent } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
    consent: {
        prompts: [] as string[],
        /** The next answers, in order; `true` when the queue is empty. A function holds the prompt open. */
        queue: [] as (boolean | ((release: (ok: boolean) => void) => void))[],
    },
}));

vi.mock("src/ts/storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: vi.fn((prompt: string) => {
            consent.prompts.push(prompt);
            const next = consent.queue.shift();
            if (typeof next === "function") {
                return new Promise<boolean>((resolve) => next(resolve));
            }
            return Promise.resolve(next ?? true);
        }),
    }),
);
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleMcps: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
const text = (result: RPCToolCallContent[] | null) => (result ?? []).map((content) => (content as any).text).join("");

const lore = (comment: string, content: string, key = "") => ({
    key,
    content,
    comment,
    alwaysActive: false,
    secondkey: "",
    selective: false,
    insertorder: 100,
    mode: "normal",
});
const regex = (comment: string) => ({
    comment,
    in: `${comment}In`,
    out: `${comment}Out`,
    type: "editdisplay",
    flag: "",
    ableFlag: true,
});
const luaTrigger = (code: string) => ({
    comment: "first",
    type: "manual",
    conditions: [{ type: "var", var: "x", value: "1", operator: "=" }],
    effect: [
        { type: "triggerlua", code },
        { type: "setvar", var: "y", value: "2", operator: "=" },
    ],
});

/**
 * Boots the harness, adds a second character and selects it (so the seeded `c`, whose `globalLore` is
 * the default empty list, is not the selected one), and loads the character handler on that module graph.
 */
async function boot() {
    vi.resetModules();
    consent.prompts.length = 0;
    consent.queue.length = 0;
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { CharacterHandler } = await import("../characters");
    const handler = new CharacterHandler();
    const call = async (tool: string, args: Record<string, unknown>) => text(await handler.handle(tool, args));
    const other = booted.characterStore.addCharacter({ name: "Other", desc: "other" });
    booted.selectionModule.selectCharacter(other);
    await booted.sync.flushResources();
    booted.fake.requests.length = 0;
    /** Holds the next consent prompt open; `release` answers it. */
    const hold = () => {
        let release!: (ok: boolean) => void;
        consent.queue.push((resolve) => {
            release = resolve;
        });
        return (ok: boolean) => release(ok);
    };
    /** Runs `act`, then checks that neither the mirror nor the server changed and nothing was sent. */
    const unchanged = async (act: () => Promise<string>) => {
        const mirror = booted.mirrorText();
        const serverBefore = booted.serverText();
        const batches = booted.fake.batchCount();
        const answer = await act();
        expect(booted.mirrorText()).toBe(mirror);
        await booted.sync.flushResources();
        expect(booted.serverText()).toBe(serverBefore);
        expect(booted.fake.batchCount()).toBe(batches);
        return answer;
    };
    const saved = (id = "c") => booted.record("characters", id);
    return { ...booted, handler, call, other, hold, unchanged, saved };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("write tools on a character that is not selected", () => {
    it("set-character-info writes the remapped fields in one patch by name and by id, and only that record is sent", async () => {
        const { call, sync, fake, saved, character, selectionModule, other } = await boot();
        expect(selectionModule.selectedIndex()).not.toBe(0);
        expect(
            await call("risu-set-character-info", {
                id: "C",
                data: {
                    name: "Renamed",
                    greeting: "hello",
                    description: "desc",
                    replaceGlobalNote: "note",
                    alternateGreetings: ["alt"],
                    backgroundEmbedding: "<style/>",
                },
            }),
        ).toBe("Successfully updated character Renamed");
        expect(consent.prompts).toEqual([
            'risu-set-character-info is trying to "modify character (C) information". Do you want to allow this?',
        ]);
        await sync.flushResources();
        expect(saved()).toMatchObject({
            chaId: "c",
            name: "Renamed",
            firstMessage: "hello",
            desc: "desc",
            replaceGlobalNote: "note",
            alternateGreetings: ["alt"],
            backgroundHTML: "<style/>",
        });
        expect(saved()).not.toHaveProperty("greeting");
        expect(saved()).not.toHaveProperty("description");
        expect(saved()).not.toHaveProperty("chats");
        const batches = fake.batchBodies();
        expect(batches).toHaveLength(1);
        expect(batches[0].ops.map((op: any) => `${op.kind}/${op.id}`)).toEqual(["characters/c"]);
        // By id now that the name changed; the selected character is untouched.
        expect(await call("risu-set-character-info", { id: "c", data: { description: "again" } })).toBe(
            "Successfully updated character Renamed",
        );
        await sync.flushResources();
        expect(saved().desc).toBe("again");
        expect(saved(other).desc).toBe("other");
        expect(character(other).desc).toBe("other");
    });

    it("the lorebook tools add to an empty globalLore, update one entry, and delete it, each saved by the next cycle", async () => {
        const { call, sync, saved, character } = await boot();
        expect(character("c").globalLore).toEqual([]);
        expect(
            await call("risu-set-character-lorebook", {
                id: "c",
                name: "Town",
                content: "A town",
                keys: ["town", "city"],
            }),
        ).toBe('Successfully added lorebook entry "Town" to character C');
        await sync.flushResources();
        expect(saved().globalLore).toEqual([{ ...lore("Town", "A town", "town,city"), alwaysActive: false }]);
        expect(
            await call("risu-set-character-lorebook", {
                id: "c",
                name: "Town",
                content: "A city",
                newName: "City",
                alwaysActive: true,
            }),
        ).toBe('Successfully updated lorebook entry "Town" for character C');
        expect(await call("risu-set-character-lorebook", { id: "c", name: "Second", content: "s" })).toBe(
            'Successfully added lorebook entry "Second" to character C',
        );
        await sync.flushResources();
        expect(saved().globalLore).toEqual([
            { ...lore("City", "A city", ""), alwaysActive: true },
            lore("Second", "s"),
        ]);
        expect(await call("risu-delete-character-lorebook", { id: "c", name: "City" })).toBe(
            'Successfully deleted lorebook entry "City" from character C',
        );
        await sync.flushResources();
        expect(saved().globalLore).toEqual([lore("Second", "s")]);
    });

    it("the regex, asset, and Lua tools patch their one list and keep the rest of the record", async () => {
        const { call, sync, saved, characterStore } = await boot();
        characterStore.updateCharacter("c", {
            customscript: [regex("a"), regex("b")],
            additionalAssets: [
                ["img", "path/img", "png"],
                ["snd", "path/snd", "mp3"],
            ],
            triggerscript: [luaTrigger("-- old"), { comment: "second", type: "manual", conditions: [], effect: [] }],
            desc: "kept",
        });
        await sync.flushResources();
        expect(
            await call("risu-set-character-regex-scripts", {
                id: "c",
                name: "a",
                out: "changed",
                type: "editinput",
                ableFlag: false,
            }),
        ).toBe('Successfully updated regex script "a" for character C');
        expect(await call("risu-set-character-regex-scripts", { id: "c", name: "new", in: "x", out: "y" })).toBe(
            'Successfully added regex script "new" to character C',
        );
        expect(await call("risu-delete-character-regex-scripts", { id: "c", name: "b" })).toBe(
            'Successfully deleted regex script "b" from character C',
        );
        expect(await call("risu-delete-character-additional-assets", { id: "c", assetName: "img" })).toBe(
            'Successfully deleted additional asset "img" from character C',
        );
        expect(await call("risu-set-character-lua-script", { id: "c", code: "-- new" })).toBe(
            "Successfully updated Lua script for character C",
        );
        await sync.flushResources();
        const record = saved();
        expect(record.customscript).toEqual([
            { ...regex("a"), out: "changed", type: "editinput", ableFlag: false },
            { comment: "new", in: "x", out: "y", type: "editdisplay", flag: "", ableFlag: true },
        ]);
        expect(record.additionalAssets).toEqual([["snd", "path/snd", "mp3"]]);
        // The Lua code is replaced in a copy: the other effect, the conditions, and the second trigger survive.
        expect(record.triggerscript).toEqual([
            luaTrigger("-- new"),
            { comment: "second", type: "manual", conditions: [], effect: [] },
        ]);
        expect(record.desc).toBe("kept");
        expect(await call("risu-get-character-lua-script", { id: "c" })).toBe("-- new");
    });

    it("an empty id addresses the selected character", async () => {
        const { call, sync, saved, other } = await boot();
        expect(await call("risu-set-character-info", { id: "", data: { description: "selected" } })).toBe(
            "Successfully updated character Other",
        );
        await sync.flushResources();
        expect(saved(other).desc).toBe("selected");
        // `c` keeps its default description.
        expect(saved("c").desc).toBe("");
    });
});

describe("nothing is written", () => {
    it("when the user denies the consent prompt, for every write tool", async () => {
        const { call, unchanged, characterStore, sync } = await boot();
        characterStore.updateCharacter("c", {
            globalLore: [lore("Town", "t")],
            customscript: [regex("a")],
            additionalAssets: [["img", "p", "png"]],
            triggerscript: [luaTrigger("-- old")],
        });
        await sync.flushResources();
        const writes: [string, Record<string, unknown>][] = [
            ["risu-set-character-info", { id: "c", data: { name: "Denied" } }],
            ["risu-set-character-lorebook", { id: "c", name: "Town", content: "x" }],
            ["risu-delete-character-lorebook", { id: "c", name: "Town" }],
            ["risu-set-character-regex-scripts", { id: "c", name: "a", out: "x" }],
            ["risu-delete-character-regex-scripts", { id: "c", name: "a" }],
            ["risu-delete-character-additional-assets", { id: "c", assetName: "img" }],
            ["risu-set-character-lua-script", { id: "c", code: "-- x" }],
        ];
        for (const [tool, args] of writes) {
            consent.queue.push(false);
            expect(await unchanged(() => call(tool, args))).toBe("Access denied by user.");
        }
        expect(consent.prompts).toHaveLength(writes.length);
    });

    it("when the entry, script, or asset does not exist, or the first trigger is not Lua", async () => {
        const { call, unchanged } = await boot();
        expect(await unchanged(() => call("risu-delete-character-lorebook", { id: "c", name: "nope" }))).toBe(
            'Error: Lorebook entry with name "nope" not found.',
        );
        expect(await unchanged(() => call("risu-delete-character-regex-scripts", { id: "c", name: "nope" }))).toBe(
            'Error: Regex script with name "nope" not found.',
        );
        expect(
            await unchanged(() => call("risu-delete-character-additional-assets", { id: "c", assetName: "nope" })),
        ).toBe('Error: Additional asset with name "nope" not found.');
        expect(await unchanged(() => call("risu-set-character-lua-script", { id: "c", code: "-- x" }))).toBe(
            "Error: User must first change the first trigger type to Lua manually.",
        );
    });

    it("when a field is unknown or inherited (constructor, toString, a parsed __proto__), even next to valid ones", async () => {
        const { call, unchanged } = await boot();
        const bad: Record<string, unknown>[] = [
            { name: "Changed", nope: 1 },
            { name: "Changed", constructor: "bad" },
            { toString: "t", description: "d" },
            JSON.parse('{"name":"Changed","__proto__":{"x":1}}'),
            { hasOwnProperty: 1 },
            { id: "other" },
        ];
        for (const data of bad) {
            const field = Object.keys(data).find((key) => !["name", "description"].includes(key));
            expect(await unchanged(() => call("risu-set-character-info", { id: "c", data }))).toBe(
                `Error: Field ${field} does not exist on character c or it isn't allowed to be modified.`,
            );
        }
    });

    it("when the mutation refuses the patch (a non-data value) or the id names a group", async () => {
        const { call, unchanged, characterStore, sync } = await boot();
        expect(
            await unchanged(() =>
                call("risu-set-character-info", { id: "c", data: { name: "ok", description: () => 1 } }),
            ),
        ).toMatch(/^Error: desc: the value is not JSON data/);
        expect(
            await unchanged(() => call("risu-set-character-lorebook", { id: "c", name: "L", content: 1n as any })),
        ).toMatch(/^Error: globalLore: the value is not JSON data/);
        characterStore.addCharacter({ chaId: "g", name: "Group", type: "group", characters: [] });
        await sync.flushResources();
        expect(await unchanged(() => call("risu-set-character-info", { id: "g", data: { name: "x" } }))).toBe(
            "Error: The id pointed to a group chat, not a character.",
        );
        expect(await unchanged(() => call("risu-set-character-info", { id: "nope", data: { name: "x" } }))).toBe(
            "Error: Character with ID nope not found.",
        );
        expect(consent.prompts).toHaveLength(2);
    });
});

describe("the consent gate", () => {
    it("builds the write from the record as it is after consent: a lorebook replaced while the prompt was open is patched", async () => {
        const { call, hold, characterStore, sync, saved } = await boot();
        characterStore.updateCharacter("c", { globalLore: [lore("Old", "o")] });
        const release = hold();
        const pending = call("risu-set-character-lorebook", { id: "c", name: "Added", content: "a" });
        expect(consent.prompts).toHaveLength(1);
        characterStore.updateCharacter("c", { globalLore: [lore("Fresh", "f")] });
        release(true);
        expect(await pending).toBe('Successfully added lorebook entry "Added" to character C');
        await sync.flushResources();
        expect(saved().globalLore).toEqual([lore("Fresh", "f"), lore("Added", "a")]);
    });

    it("leaves no gap between the lookup after consent and the write (Astra challenge 1)", async () => {
        const { call, hold, characterStore, character, sync, saved } = await boot();
        characterStore.updateCharacter("c", { globalLore: [lore("Old", "o")] });
        const release = hold();
        const pending = call("risu-set-character-lorebook", { id: "c", name: "Added", content: "a" });
        let seenAtReplacement: unknown = null;
        // Astra's probe: consent resolves, and a replacement is queued as the very next microtask. With
        // an await between the post-consent lookup and the write, the replacement ran in that gap and
        // the write carried the old list over it.
        release(true);
        queueMicrotask(() => {
            seenAtReplacement = plain(character("c").globalLore);
            characterStore.updateCharacter("c", { globalLore: [lore("Fresh", "f")] });
        });
        expect(await pending).toBe('Successfully added lorebook entry "Added" to character C');
        // The write had landed before the microtask ran, and the later replacement is what remains.
        expect(seenAtReplacement).toEqual([lore("Old", "o"), lore("Added", "a")]);
        expect(plain(character("c").globalLore)).toEqual([lore("Fresh", "f")]);
        await sync.flushResources();
        expect(saved().globalLore).toEqual([lore("Fresh", "f")]);
    });

    it("keeps the captured id as the target through a rename, a same-name character, and a selection change", async () => {
        const { call, hold, characterStore, selectionModule, sync, saved } = await boot();
        const release = hold();
        const pending = call("risu-set-character-info", { id: "C", data: { description: "by name" } });
        characterStore.updateCharacter("c", { name: "Zed" });
        const twin = characterStore.addCharacter({ chaId: "c2", name: "C" });
        selectionModule.selectCharacter(twin);
        release(true);
        expect(await pending).toBe("Successfully updated character Zed");
        await sync.flushResources();
        expect(saved("c")).toMatchObject({ name: "Zed", desc: "by name" });
        // The twin keeps its default description.
        expect(saved("c2").desc).toBe("");
        // The empty id resolves the selection at entry, not at consent.
        const releaseSelected = hold();
        const pendingSelected = call("risu-set-character-info", { id: "", data: { description: "was selected" } });
        selectionModule.selectCharacterAt(0);
        releaseSelected(true);
        expect(await pendingSelected).toBe("Successfully updated character C");
        await sync.flushResources();
        expect(saved("c2").desc).toBe("was selected");
        expect(saved("c").desc).toBe("by name");
    });

    it("answers not found for a character removed while the prompt was open, and recreates nothing", async () => {
        const { call, hold, characterStore, fake, characterList, sync } = await boot();
        const release = hold();
        const pending = call("risu-set-character-lorebook", { id: "c", name: "X", content: "x" });
        expect(characterStore.removeCharacter("c")).toBe(true);
        release(true);
        expect(await pending).toBe("Error: Character with ID c not found.");
        await sync.flushResources();
        expect(fake.record("characters", "c")).toBeNull();
        expect(characterList().some((entry: any) => entry.chaId === "c")).toBe(false);
    });

    it("refuses a character that became a group while the prompt was open", async () => {
        const { call, hold, character, unchanged, saved, sync } = await boot();
        const release = hold();
        const pending = call("risu-set-character-info", { id: "c", data: { name: "x" } });
        character("c").type = "group";
        // Every write of a character's own fields is saved, selected or not (Phase 6 slice 5): the
        // test's own change reaches the server first, so the check below sees only the refusal.
        await sync.flushResources();
        expect(saved().type).toBe("group");
        expect(
            await unchanged(async () => {
                release(true);
                return pending;
            }),
        ).toBe("Error: The id pointed to a group chat, not a character.");
    });
});

describe("read tools", () => {
    it("return the same shapes as before, with the default empty globalLore read as empty", async () => {
        const { call, characterStore, other, sync } = await boot();
        expect(await call("risu-list-character-lorebooks", { id: "c" })).toBe("[]");
        expect(await call("risu-get-character-lorebook", { id: "c", names: ["x"] })).toBe(
            'Error: Lorebook entries with names "x" not found.',
        );
        expect(await call("risu-get-character-regex-scripts", { id: "c" })).toBe("[]");
        expect(await call("risu-get-character-additional-assets", { id: "c" })).toBe("[]");
        expect(await call("risu-get-character-lua-script", { id: "c" })).toBe(
            "Error: This character does not contain a Lua trigger as the first trigger.",
        );
        characterStore.updateCharacter("c", {
            globalLore: [lore("Town", "t", "k1,k2"), { ...lore("", "unnamed"), alwaysActive: true }],
            customscript: [regex("a")],
            additionalAssets: [["img", "p", "png"]],
            triggerscript: [luaTrigger("print(1)")],
            firstMessage: "hi",
        });
        await sync.flushResources();
        expect(await call("risu-get-character-info", { id: "c", fields: ["id", "name", "greeting"] })).toBe(
            JSON.stringify({ id: "c", name: "C", greeting: "hi" }),
        );
        expect(await call("risu-get-character-info", { id: "c", fields: ["chats"] })).toBe(
            "Error: Field chats does not exist on character c or it isn't allowed to be accessed.",
        );
        expect(await call("risu-list-character-lorebooks", { id: "c", count: 1 })).toBe(
            JSON.stringify([{ alwaysActive: false, keys: "k1,k2", name: "Town" }]),
        );
        expect(JSON.parse(await call("risu-list-character-lorebooks", { id: "c", offset: 1 }))).toEqual([
            { alwaysActive: true, keys: "", name: expect.stringMatching(/^Unnamed /) },
        ]);
        expect(await call("risu-get-character-lorebook", { id: "c", names: ["Town"] })).toBe(
            JSON.stringify([{ alwaysActive: false, content: "t", keys: "k1,k2", name: "Town" }]),
        );
        expect(await call("risu-get-character-regex-scripts", { id: "c" })).toBe(JSON.stringify([regex("a")]));
        expect(await call("risu-get-character-additional-assets", { id: "c" })).toBe(
            JSON.stringify([{ name: "img", path: "p", ext: "png" }]),
        );
        expect(await call("risu-get-character-lua-script", { id: "c" })).toBe("print(1)");
        // Both characters carry the default `type` (the server's for `c`, the creation's for `Other`).
        expect(await call("risu-list-characters", {})).toBe(
            JSON.stringify([
                { id: "c", name: "C", type: "character" },
                { id: other, name: "Other", type: "character" },
            ]),
        );
        // A read asks for no consent.
        expect(consent.prompts).toEqual([]);
    });
});
