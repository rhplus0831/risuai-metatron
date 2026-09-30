import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "../storage/tests/mutationStoresHarness";

// Phase 4, slice 6 (`docs/plan/phases/slices/phase-4-external-contracts/trigger-effect-writers.md`):
// the v2 trigger character and persona effects (`runTrigger`) over the real save adapter and the
// real server store (`storeBackedServer.ts`). The eight character effects (six `globalLore`
// writers, `v2SetCharacterDesc`, `v2SetReplaceGlobalNote`) write the trigger's own character (the
// working copy's `chaId`; in a group send the speaking member) one field at a time through
// `updateCharacter`: the selected character, the group, and the other fields of that character are
// untouched, and only that record is sent. `v2SetPersonaDesc` writes the persona selected when the
// effect runs through `updatePersona`, warns and skips when none is selected. A gone character or a
// refused patch is warned about and the trigger goes on. Display and request runs (`displayMode`)
// make no mutation call, whether their effects are filtered by the allowlists or reach the guards.
// The deprecated `v2ModifyLorebook` and `v2SetLorebookActivation` are pinned as they are routed
// today (the target and the write); their array-shaped entry access is a recorded, separate task.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        /** `alertInput`: the tests swap it to hold a trigger open. */
        input: vi.fn(async (): Promise<string> => ""),
    },
}));

vi.mock("../storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: vi.fn(async () => true),
    alertSelect: vi.fn(async () => ""),
    alertInput: (...args: unknown[]) => alerts.input(...(args as [])),
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
    fetchNative: vi.fn(),
    readImage: vi.fn(),
}));
vi.mock("./files/inlays", () => ({ getInlayAsset: vi.fn(), writeInlayImage: vi.fn(async () => "inlay1") }));
vi.mock("./lorebook.svelte", () => ({ loadLoreBookV3Prompt: vi.fn() }));
vi.mock("./memory/hypamemory", () => ({ HypaProcesser: vi.fn() }));
vi.mock("./request/request", () => ({ requestChatData: vi.fn() }));
vi.mock("./stableDiff", () => ({ generateAIImage: vi.fn() }));
vi.mock("./command", () => ({ processMultiCommand: vi.fn() }));
vi.mock("../tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
// wasmoon under happy-dom: see `scriptingsSetters.test.ts` (the `<base>` element and the `file:` glue).
const wasmoonDist = dirname(createRequire(import.meta.url).resolve("wasmoon"));
vi.mock("wasmoon", async (importOriginal) => {
    const original = await importOriginal<typeof import("wasmoon")>();
    const { pathToFileURL } = await import("node:url");
    const { createRequire } = await import("node:module");
    const glue = pathToFileURL(createRequire(import.meta.url).resolve("wasmoon/dist/glue.wasm")).href;
    class LuaFactory extends original.LuaFactory {
        constructor() {
            super(glue);
        }
    }
    return { ...original, LuaFactory };
});

let jsonLua = "";
let warn: ReturnType<typeof vi.spyOn>;

type Effect = Record<string, unknown>;
type TriggerType = "start" | "manual" | "output" | "input" | "display" | "request";

const lore = (comment: string, content: string) => ({
    key: comment.toLowerCase(),
    comment,
    content,
    alwaysActive: false,
    secondkey: "",
    selective: false,
    insertorder: 100,
    mode: "normal",
});
const memberLore = () => [lore("Alpha", "a"), lore("Beta", "b")];
const gamma = {
    key: "g",
    comment: "Gamma",
    content: "c",
    mode: "normal",
    insertorder: 5,
    alwaysActive: false,
    secondkey: "",
    selective: false,
};

const effects = {
    create: {
        type: "v2CreateLorebook",
        name: "Gamma",
        nameType: "value",
        key: "g",
        keyType: "value",
        content: "c",
        contentType: "value",
        insertOrder: "5",
        insertOrderType: "value",
        indent: 0,
    },
    modifyByIndex: {
        type: "v2ModifyLorebookByIndex",
        index: "1",
        indexType: "value",
        name: "{{slot}}!",
        nameType: "value",
        key: "k2",
        keyType: "value",
        content: "new {{slot}}",
        contentType: "value",
        insertOrder: "7",
        insertOrderType: "value",
        indent: 0,
    },
    deleteByIndex: { type: "v2DeleteLorebookByIndex", index: "0", indexType: "value", indent: 0 },
    alwaysActive: { type: "v2SetLorebookAlwaysActive", index: "1", indexType: "value", value: true, indent: 0 },
    modifyLore: {
        type: "v2ModifyLorebook",
        target: "Alpha",
        targetType: "value",
        value: "x",
        valueType: "value",
        indent: 0,
    },
    activation: (index: string, indexType: "var" | "value" = "value") => ({
        type: "v2SetLorebookActivation",
        index,
        indexType,
        value: true,
        indent: 0,
    }),
    setDesc: (value: string) => ({ type: "v2SetCharacterDesc", value, valueType: "value", indent: 0 }),
    setNote: (value: string) => ({ type: "v2SetReplaceGlobalNote", value, valueType: "value", indent: 0 }),
    setPersona: (value: string) => ({ type: "v2SetPersonaDesc", value, valueType: "value", indent: 0 }),
    getDesc: (outputVar: string) => ({ type: "v2GetCharacterDesc", outputVar, indent: 0 }),
    getPersona: (outputVar: string) => ({ type: "v2GetPersonaDesc", outputVar, indent: 0 }),
    setVar: (name: string, value: string) => ({
        type: "v2SetVar",
        operator: "=",
        var: name,
        valueType: "value",
        value,
        indent: 0,
    }),
    wait: { type: "v2GetAlertInput", display: "wait", displayType: "value", outputVar: "answer", indent: 0 },
    lua: (code: string) => ({ type: "triggerlua", code }),
} satisfies Record<string, Effect | ((...args: any[]) => Effect)>;

/** Holds the next `alertInput` open; the returned function answers it. */
function holdInput() {
    let release!: (value: string) => void;
    alerts.input.mockImplementationOnce(
        () =>
            new Promise<string>((resolve) => {
                release = resolve;
            }),
    );
    return (value: string) => release(value);
}

/** Waits until `alertInput` was called `count` times (the trigger reached its wait). */
async function inputCalled(count: number) {
    for (let i = 0; i < 5000 && alerts.input.mock.calls.length < count; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(alerts.input.mock.calls.length).toBe(count);
}

const warnings = (text: string) => warn.mock.calls.filter(([message]) => String(message).includes(text)).length;

/**
 * Boots the harness with `other` (selected; its own lore, description, and note), `member` (the
 * trigger's character: two object-shaped lore entries, a description, a note, and unrelated fields),
 * `second` (another typed character), and `group` (of `member` and `second`), flushes, and loads
 * `triggers.ts` on that module graph. The seeded `c` has no lore.
 */
async function boot() {
    vi.resetModules();
    if (!document.querySelector("base")) {
        const base = document.createElement("base");
        base.setAttribute("href", pathToFileURL(`${wasmoonDist}/`).href);
        document.head.appendChild(base);
    }
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { characterStore, collectionStore, stores, db, sync, fake, chat } = booted;
    const index = (chaId: string) => db().characters.findIndex((entry: any) => entry?.chaId === chaId);
    const other = characterStore.addCharacter({
        type: "character",
        name: "Other",
        desc: "other",
        replaceGlobalNote: "other note",
        globalLore: [lore("Sel", "s")],
    });
    const member = characterStore.addCharacter({
        type: "character",
        name: "Member",
        desc: "member",
        firstMessage: "hello",
        replaceGlobalNote: "member note",
        globalLore: memberLore(),
    });
    const second = characterStore.addCharacter({
        type: "character",
        name: "Second",
        desc: "second",
        globalLore: [lore("Two", "2")],
    });
    const group = characterStore.addCharacter({ type: "group", name: "Group", characters: [member, second] });
    stores.selectedCharID.set(index(other));
    await sync.flushResources();
    fake.requests.length = 0;
    const triggers = await import("./triggers");
    // The mutation modules stay real (a `vi.mock` wrapper would outlive `vi.resetModules` and keep
    // the first graph's `DBState`); the writers are spied on this graph's namespaces to count calls.
    const updateCharacter = vi.spyOn(characterStore, "updateCharacter");
    const updatePersona = vi.spyOn(collectionStore, "updatePersona");
    const chatRefOf = (chaId: string) => ({ chaId, chatId: booted.character(chaId).chats[0].id as string });
    /** Gives `chaId` one trigger of `type` with `list` as its effects, saved; the spies start clean after it. */
    const install = async (chaId: string, list: Effect[], type: TriggerType = "output") => {
        characterStore.updateCharacter(chaId, {
            triggerscript: [{ comment: "t", type, conditions: [], effect: list }],
        });
        await sync.flushResources();
        fake.requests.length = 0;
        updateCharacter.mockClear();
        updatePersona.mockClear();
    };
    /**
     * Runs the live record of `chaId` in `mode` as the callers do: with the chat of `chatRef` (its
     * own first chat by default; `null` for the display runner, which passes no ref).
     */
    const execute = (
        chaId: string,
        mode: TriggerType = "output",
        options: {
            chatRef?: { chaId: string; chatId: string } | null;
            displayMode?: boolean;
            displayData?: string;
        } = {},
    ) => {
        const ref = options.chatRef === undefined ? chatRefOf(chaId) : options.chatRef;
        return triggers.runTrigger(booted.character(chaId) as any, mode, {
            chat: chat.findChat(ref ?? chatRefOf(chaId))!,
            ...(ref ? { chatRef: ref } : {}),
            ...(options.displayMode ? { displayMode: true, displayData: options.displayData } : {}),
        });
    };
    const run = async (chaId: string, list: Effect[], options: Parameters<typeof execute>[2] = {}) => {
        await install(chaId, list);
        return execute(chaId, "output", options);
    };
    const saved = (chaId: string) => booted.record("characters", chaId);
    /** The `kind/id` of every record op sent so far, per batch. */
    const sentOps = () =>
        fake.batchBodies().map((batch: any) => (batch.ops ?? []).map((op: any) => `${op.kind}/${op.id}`));
    return {
        ...booted,
        triggers,
        updateCharacter,
        updatePersona,
        index,
        other,
        member,
        second,
        group,
        chatRefOf,
        install,
        execute,
        run,
        saved,
        sentOps,
    };
}

beforeAll(async () => {
    jsonLua = await readFile(resolve(process.cwd(), "public/lua/json.lua"), "utf8");
});

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(jsonLua, { status: 200 })),
    );
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    alerts.input.mockImplementation(async () => "");
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("the character effects write the trigger's character", () => {
    /** The effect, the field it writes, the value that lands, and whether the record's text changes (so the adapter sends it). */
    const cases: [string, Effect, "globalLore" | "desc" | "replaceGlobalNote", unknown, boolean][] = [
        ["v2CreateLorebook", effects.create, "globalLore", [...memberLore(), gamma], true],
        [
            "v2ModifyLorebookByIndex",
            effects.modifyByIndex,
            "globalLore",
            [
                lore("Alpha", "a"),
                { ...lore("Beta", "b"), comment: "Beta!", key: "k2", content: "new b", insertorder: 7 },
            ],
            true,
        ],
        ["v2DeleteLorebookByIndex", effects.deleteByIndex, "globalLore", [lore("Beta", "b")], true],
        [
            "v2SetLorebookAlwaysActive",
            effects.alwaysActive,
            "globalLore",
            [lore("Alpha", "a"), { ...lore("Beta", "b"), alwaysActive: true }],
            true,
        ],
        ["v2SetCharacterDesc", effects.setDesc("new desc"), "desc", "new desc", true],
        ["v2SetReplaceGlobalNote", effects.setNote("new note"), "replaceGlobalNote", "new note", true],
        // Deprecated (recorded, a separate task): `v2ModifyLorebook` matches `entry[0]`, which no
        // object entry has, so the list is written unchanged (and the compare-and-save adapter then
        // sends nothing); `v2SetLorebookActivation` writes `entry[2]`, a stray key, and leaves
        // `alwaysActive` alone. Pinned as routed today: the target and the write.
        ["v2ModifyLorebook", effects.modifyLore, "globalLore", memberLore(), false],
        [
            "v2SetLorebookActivation",
            effects.activation("0"),
            "globalLore",
            [{ ...lore("Alpha", "a"), "2": true }, lore("Beta", "b")],
            true,
        ],
    ];

    it.each(cases)(
        "%s writes one field of the non-selected trigger character, keeps its other fields and the selected one, and sends only that record",
        async (_name, effect, field, expected, changes) => {
            const {
                run,
                sync,
                fake,
                saved,
                character,
                stores,
                index,
                other,
                member,
                updateCharacter,
                updatePersona,
                sentOps,
            } = await boot();
            const untouched = { desc: "member", replaceGlobalNote: "member note", globalLore: memberLore() };
            delete (untouched as Record<string, unknown>)[field];
            await run(member, [effect]);
            expect(plain(character(member))[field]).toEqual(expected);
            expect(plain(character(member))).toMatchObject({ name: "Member", firstMessage: "hello", ...untouched });
            expect(plain(character(other))).toMatchObject({
                desc: "other",
                replaceGlobalNote: "other note",
                globalLore: [lore("Sel", "s")],
            });
            expect(get(stores.selectedCharID)).toBe(index(other));
            expect(updateCharacter.mock.calls).toEqual([[member, { [field]: expected }]]);
            expect(updatePersona).not.toHaveBeenCalled();
            await sync.flushResources();
            expect(saved(member)[field]).toEqual(expected);
            expect(saved(member)).toMatchObject({ name: "Member", firstMessage: "hello", ...untouched });
            expect(saved(other)).toMatchObject({ desc: "other", globalLore: [lore("Sel", "s")] });
            expect(sentOps()).toEqual(changes ? [[`characters/${member}`]] : []);
            expect(fake.batchBodies().flatMap((batch: any) => batch.chats ?? [])).toEqual([]);
        },
    );

    it("in a group send (the member's copy, the group's chat) the writes land on the speaking member, not the group, the other member, or the selection", async () => {
        const {
            run,
            sync,
            saved,
            character,
            chat,
            stores,
            index,
            other,
            member,
            second,
            group,
            chatRefOf,
            updateCharacter,
            sentOps,
        } = await boot();
        stores.selectedCharID.set(index(group));
        const groupRef = chatRefOf(group);
        await run(
            member,
            [effects.create, effects.setDesc("spoke"), effects.setNote("group note"), effects.setVar("x", "1")],
            {
                chatRef: groupRef,
            },
        );
        expect(plain(character(member))).toMatchObject({
            desc: "spoke",
            replaceGlobalNote: "group note",
            globalLore: [...memberLore(), gamma],
        });
        expect(plain(character(group))).toMatchObject({ type: "group", name: "Group", characters: [member, second] });
        expect(character(group)).not.toHaveProperty("desc");
        expect(character(group)).not.toHaveProperty("globalLore");
        expect(character(group)).not.toHaveProperty("replaceGlobalNote");
        expect(plain(character(second))).toMatchObject({ desc: "second", globalLore: [lore("Two", "2")] });
        expect(plain(character(other))).toMatchObject({ desc: "other", globalLore: [lore("Sel", "s")] });
        expect(
            updateCharacter.mock.calls.map(([chaId, patch]: [string, object]) => [chaId, Object.keys(patch)]),
        ).toEqual([
            [member, ["globalLore"]],
            [member, ["desc"]],
            [member, ["replaceGlobalNote"]],
        ]);
        // The variable went to the group's chat (the send's chat), not the member's.
        expect(chat.findChat(groupRef)?.scriptstate).toEqual({ $x: "1" });
        expect(chat.findChat(chatRefOf(member))?.scriptstate).toBeUndefined();
        expect(get(stores.selectedCharID)).toBe(index(group));
        await sync.flushResources();
        expect(saved(member)).toMatchObject({
            desc: "spoke",
            replaceGlobalNote: "group note",
            globalLore: [...memberLore(), gamma],
        });
        expect(saved(group)).toEqual({ chaId: group, type: "group", name: "Group", characters: [member, second] });
        expect(saved(second)).toMatchObject({ desc: "second", globalLore: [lore("Two", "2")] });
        expect(sentOps()).toEqual([[`characters/${member}`]]);
    });

    it("v2SetLorebookActivation warns and skips a negative, fractional, non-numeric, unset, or out-of-range index, and later effects still run", async () => {
        const { run, sync, saved, character, member, updateCharacter, sentOps } = await boot();
        const result = await run(member, [
            effects.activation("-1"),
            effects.activation("0.5"),
            effects.activation("abc"),
            effects.activation("unsetVar", "var"),
            effects.activation("2"),
            effects.setDesc("after"),
        ]);
        expect(result).not.toBeNull();
        expect(warnings("No lorebook entry at this index")).toBe(5);
        expect(plain(character(member)).globalLore).toEqual(memberLore());
        expect(character(member).desc).toBe("after");
        expect(updateCharacter.mock.calls).toEqual([[member, { desc: "after" }]]);
        await sync.flushResources();
        expect(saved(member)).toMatchObject({ desc: "after", globalLore: memberLore() });
        expect(sentOps()).toEqual([[`characters/${member}`]]);

        // An empty list: index 0 names nothing either.
        await run("c", [effects.activation("0"), effects.setNote("c note")]);
        expect(warnings("No lorebook entry at this index")).toBe(6);
        expect(character("c")).not.toHaveProperty("globalLore");
        expect(character("c").replaceGlobalNote).toBe("c note");
        expect(updateCharacter.mock.calls).toEqual([["c", { replaceGlobalNote: "c note" }]]);
    });

    it("a Lua description edit earlier in the trigger survives the native lore and note writes (one-field patches); the native getter still reads the copy", async () => {
        const { run, sync, saved, character, chat, chatRefOf, member, other, updateCharacter, sentOps } = await boot();
        const code = `
            onOutput = async(function(id)
                setDescription(id, "Lua edit")
            end)
        `;
        await run(member, [effects.lua(code), effects.getDesc("seen"), effects.create, effects.setNote("after lua")]);
        expect(plain(character(member))).toMatchObject({
            name: "Member",
            desc: "Lua edit",
            replaceGlobalNote: "after lua",
            globalLore: [...memberLore(), gamma],
        });
        expect(plain(character(other))).toMatchObject({ desc: "other", replaceGlobalNote: "other note" });
        expect(
            updateCharacter.mock.calls.map(([chaId, patch]: [string, object]) => [chaId, Object.keys(patch)]),
        ).toEqual([
            [member, ["desc"]],
            [member, ["globalLore"]],
            [member, ["replaceGlobalNote"]],
        ]);
        // Recorded (Astra challenge 3, Phase 5): the working copy is taken at run start, so a
        // native getter after the Lua write still answers the old description.
        expect(chat.findChat(chatRefOf(member))?.scriptstate).toEqual({ $seen: "member" });
        await sync.flushResources();
        expect(saved(member)).toMatchObject({
            desc: "Lua edit",
            replaceGlobalNote: "after lua",
            globalLore: [...memberLore(), gamma],
        });
        expect(saved(other)).toMatchObject({ desc: "other" });
        expect(sentOps()).toEqual([[`characters/${member}`]]);
    });
});

describe("a trigger suspended at an alert", () => {
    it("resumes onto the character it started with although the selection moved, and keeps a field edited meanwhile", async () => {
        const {
            install,
            execute,
            sync,
            saved,
            character,
            characterStore,
            stores,
            index,
            member,
            other,
            updateCharacter,
            sentOps,
        } = await boot();
        await install(member, [effects.wait, effects.setDesc("resumed"), effects.create]);
        const release = holdInput();
        const pending = execute(member);
        await inputCalled(1);
        stores.selectedCharID.set(index("c"));
        characterStore.updateCharacter(member, { name: "Renamed" });
        characterStore.updateCharacter("c", { desc: "c desc" });
        release("go");
        expect(await pending).not.toBeNull();
        expect(plain(character(member))).toMatchObject({
            name: "Renamed",
            desc: "resumed",
            firstMessage: "hello",
            globalLore: [...memberLore(), gamma],
        });
        expect(plain(character("c"))).toMatchObject({ name: "C", desc: "c desc" });
        expect(character("c")).not.toHaveProperty("globalLore");
        expect(plain(character(other))).toMatchObject({ desc: "other", globalLore: [lore("Sel", "s")] });
        expect(get(stores.selectedCharID)).toBe(index("c"));
        expect(updateCharacter.mock.calls.slice(2)).toEqual([
            [member, { desc: "resumed" }],
            [member, { globalLore: [...memberLore(), gamma] }],
        ]);
        await sync.flushResources();
        expect(saved(member)).toMatchObject({ name: "Renamed", desc: "resumed", globalLore: [...memberLore(), gamma] });
        expect(saved("c")).toMatchObject({ name: "C", desc: "c desc" });
        // One batch with both edited records (in mirror order), and nothing for the selection.
        expect(sentOps().map((ops) => [...ops].sort())).toEqual([["characters/c", `characters/${member}`].sort()]);
    });

    it("warns and goes on when its character was removed meanwhile, without recreating it or writing elsewhere", async () => {
        const { install, execute, sync, saved, fake, db, characterStore, second, other, updateCharacter, sentOps } =
            await boot();
        await install(second, [
            effects.wait,
            effects.setDesc("gone"),
            effects.setNote("gone note"),
            effects.setVar("x", "1"),
        ]);
        const release = holdInput();
        const pending = execute(second);
        await inputCalled(1);
        expect(characterStore.removeCharacter(second)).toBe(true);
        const count = db().characters.length;
        release("go");
        expect(await pending).not.toBeNull();
        expect(warnings("The character is gone")).toBe(2);
        expect(updateCharacter.mock.calls).toEqual([
            [second, { desc: "gone" }],
            [second, { replaceGlobalNote: "gone note" }],
        ]);
        expect(updateCharacter.mock.results.map((entry: { value: unknown }) => entry.value)).toEqual([false, false]);
        expect(db().characters).toHaveLength(count);
        expect(db().characters.some((entry: any) => entry?.chaId === second)).toBe(false);
        expect(db().characters.some((entry: any) => entry?.desc === "gone")).toBe(false);
        expect(plain(db().characters.find((entry: any) => entry?.chaId === other))).toMatchObject({ desc: "other" });
        await sync.flushResources();
        expect(saved(second)).toBeUndefined();
        expect(
            fake
                .batchBodies()
                .flatMap((batch: any) => batch.ops ?? [])
                .some((op: any) => op.id === second && op.data),
        ).toBe(false);
        expect(sentOps().flat()).not.toContain(`characters/${other}`);
    });

    it("warns and goes on when the patch is refused, writing nothing for that effect", async () => {
        const { install, execute, sync, saved, character, validation, member, updateCharacter, sentOps } = await boot();
        await install(member, [effects.setDesc("refused"), effects.setNote("after refusal")]);
        updateCharacter.mockImplementationOnce(() => {
            throw new validation.MutationValidationError("desc", "refused");
        });
        expect(await execute(member)).not.toBeNull();
        expect(warnings("A character change was refused")).toBe(1);
        expect(plain(character(member))).toMatchObject({ desc: "member", replaceGlobalNote: "after refusal" });
        expect(updateCharacter.mock.calls).toEqual([
            [member, { desc: "refused" }],
            [member, { replaceGlobalNote: "after refusal" }],
        ]);
        await sync.flushResources();
        expect(saved(member)).toMatchObject({ desc: "member", replaceGlobalNote: "after refusal" });
        expect(sentOps()).toEqual([[`characters/${member}`]]);
    });
});

describe("v2SetPersonaDesc", () => {
    it("writes the persona selected when the effect runs (not the chat's bound one), which the forwarded field reads back and the persona record keeps", async () => {
        const {
            install,
            execute,
            run,
            sync,
            db,
            record,
            chat,
            chatRefOf,
            collectionStore,
            selectionModule,
            selection,
            member,
            updateCharacter,
            updatePersona,
        } = await boot();
        const first = db().personas[0].id as string;
        collectionStore.addPersona({ name: "Bound", id: "bound", personaPrompt: "bound prompt" });
        selectionModule.selectPersona(first);
        chat.setChatMeta(chatRefOf(member), { bindedPersona: "bound" });
        await run(member, [effects.setPersona("from trigger"), effects.getPersona("seen")]);
        expect(db().personas.map((persona: any) => [persona.id, persona.personaPrompt])).toEqual([
            [first, "from trigger"],
            ["bound", "bound prompt"],
        ]);
        expect(db().personaPrompt).toBe("from trigger");
        expect(chat.findChat(chatRefOf(member))?.scriptstate).toEqual({ $seen: "from trigger" });
        expect(updatePersona.mock.calls).toEqual([[first, { personaPrompt: "from trigger" }]]);
        expect(updateCharacter).not.toHaveBeenCalled();

        // The selection moves while the trigger waits: the persona selected at the effect gets it.
        await install(member, [effects.wait, effects.setPersona("late")]);
        const release = holdInput();
        const pending = execute(member);
        await inputCalled(1);
        selectionModule.selectPersona("bound");
        release("go");
        await pending;
        expect(db().personas.map((persona: any) => [persona.id, persona.personaPrompt])).toEqual([
            [first, "from trigger"],
            ["bound", "late"],
        ]);
        expect(db().personaPrompt).toBe("late");
        expect(selection.personaId).toBe("bound");
        expect(updatePersona.mock.calls).toEqual([["bound", { personaPrompt: "late" }]]);
        await sync.flushResources();
        expect(record("personas").map((persona: any) => [persona.id, persona.personaPrompt])).toEqual([
            [first, "from trigger"],
            ["bound", "late"],
        ]);
    });

    it("warns and skips when no persona is selected or the write is refused, never redirecting the write, and later effects run", async () => {
        const {
            install,
            execute,
            run,
            sync,
            db,
            record,
            character,
            validation,
            selectionModule,
            selection,
            member,
            updatePersona,
        } = await boot();
        const first = db().personas[0].id as string;
        selectionModule.selectPersona("ghost");
        await run(member, [effects.setPersona("nowhere"), effects.setDesc("still runs")]);
        expect(warnings("No persona is selected")).toBe(1);
        expect(updatePersona).not.toHaveBeenCalled();
        expect(db().personas.map((persona: any) => [persona.id, persona.personaPrompt])).toEqual([[first, ""]]);
        expect(selection.personaId).toBe("ghost");
        expect(character(member).desc).toBe("still runs");

        selectionModule.selectPersona(first);
        await install(member, [effects.setPersona("refused"), effects.setNote("after persona")]);
        updatePersona.mockImplementationOnce(() => {
            throw new validation.MutationValidationError("personaPrompt", "refused");
        });
        await execute(member);
        expect(warnings("The persona description was not saved")).toBe(1);
        expect(updatePersona.mock.calls).toEqual([[first, { personaPrompt: "refused" }]]);
        expect(db().personas[0].personaPrompt).toBe("");
        expect(character(member).replaceGlobalNote).toBe("after persona");
        await sync.flushResources();
        expect(record("personas")[0].personaPrompt).toBe("");
    });
});

describe("display and request runs", () => {
    const eligible = [
        effects.setDesc("display"),
        effects.create,
        effects.activation("0"),
        effects.setNote("display note"),
        effects.setPersona("display persona"),
        effects.setVar("x", "1"),
    ];

    it("the display and request runners' effects are filtered by the allowlists: no mutation call, nothing changed, nothing sent", async () => {
        const {
            install,
            execute,
            sync,
            fake,
            db,
            character,
            chat,
            chatRefOf,
            other,
            member,
            updateCharacter,
            updatePersona,
        } = await boot();
        const first = db().personas[0].id as string;
        await install(other, eligible, "display");
        const display = await execute(other, "display", { chatRef: null, displayMode: true, displayData: "shown" });
        expect(display?.displayData).toBe("shown");
        await install(member, eligible, "request");
        const request = await execute(member, "request", { displayMode: true, displayData: JSON.stringify([]) });
        expect(request?.displayData).toBe("[]");
        expect(updateCharacter).not.toHaveBeenCalled();
        expect(updatePersona).not.toHaveBeenCalled();
        expect(plain(character(other))).toMatchObject({
            desc: "other",
            replaceGlobalNote: "other note",
            globalLore: [lore("Sel", "s")],
        });
        expect(plain(character(member))).toMatchObject({
            desc: "member",
            replaceGlobalNote: "member note",
            globalLore: memberLore(),
        });
        expect(db().personas[0]).toMatchObject({ id: first, personaPrompt: "" });
        expect(chat.findChat(chatRefOf(other))?.scriptstate).toBeUndefined();
        expect(chat.findChat(chatRefOf(member))?.scriptstate).toBeUndefined();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("an eligible effect list under displayMode reaches the guards and still makes no mutation call and sends nothing", async () => {
        const { install, execute, sync, fake, db, saved, member, updateCharacter, updatePersona } = await boot();
        const first = db().personas[0].id as string;
        await install(member, eligible, "output");
        const result = await execute(member, "output", { displayMode: true, displayData: "x" });
        expect(result?.displayData).toBe("x");
        expect(updateCharacter).not.toHaveBeenCalled();
        expect(updatePersona).not.toHaveBeenCalled();
        expect(db().personas[0]).toMatchObject({ id: first, personaPrompt: "" });
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        expect(saved(member)).toMatchObject({
            desc: "member",
            replaceGlobalNote: "member note",
            globalLore: memberLore(),
        });
    });
});
