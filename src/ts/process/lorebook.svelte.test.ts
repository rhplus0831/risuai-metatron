import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations } from "../storage/tests/mutationStoresHarness";

// Phase 5 slice 4 (`lore-templates-and-tokens`): `loadLoreBookV3Prompt` is the client wrapper of
// the shared activation (`shared/lore/activation.ts`), over the real store (`storeBackedServer.ts`),
// the real chat module, and the real module resolution (`getModuleLorebooks`). Covered here: the
// scheduling the challenge found (a plain-key search never yields; the first yield is the first
// active's token count, after its CBS and chat-variable reads), the regex keys through the
// wrapper, the scanned user name (the bound persona's), the module sources (global, chat,
// character, integration, and the persona's embedded module as it resolves today), a group chat's
// speaker names, and the keep flag written through the chat module.

const { server, alerts, hooks } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
    /** What `risuChatParser` and `tokenize` do in the current test, and what `tokenize` was asked to count. */
    hooks: {
        parse: (text: string) => text,
        tokenized: [] as string[],
    },
}));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: vi.fn(async () => true),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
    alertWait: vi.fn(),
    alertInput: vi.fn(async () => ""),
    alertSelect: vi.fn(async () => ""),
    alertAddCharacter: vi.fn(),
    alertCardExport: vi.fn(),
    alertClear: vi.fn(),
    alertModuleSelect: vi.fn(),
    alertMd: vi.fn(),
    waitAlert: vi.fn(),
}));
vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => hooks.parse(text)),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./index.svelte", () => ({ doingChat: { set: vi.fn(), subscribe: vi.fn() } }));
vi.mock("../translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("../tokenizer", () => ({
    tokenize: vi.fn(async (text: string) => {
        hooks.tokenized.push(text);
        return text.length;
    }),
}));
vi.mock("../rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "../rpack/rpack_map.bin")));
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(map.slice(0, 256)), decodeRPack: apply(map.slice(256, 512)) };
});

const lore = (comment: string, key: string, content: string, extra: Record<string, unknown> = {}) => ({
    key,
    secondkey: "",
    insertorder: 100,
    comment,
    content,
    mode: "normal",
    alwaysActive: false,
    selective: false,
    ...extra,
});
const message = (chatId: string, role: "user" | "char", data: string, extra: Record<string, unknown> = {}) => ({
    chatId,
    role,
    data,
    ...extra,
});
const module = (id: string, key: string) => ({
    id,
    name: `Module ${id}`,
    description: "",
    lorebook: [lore(`lore-${id}`, key, `From ${id}`)],
});

/** Boots the harness with a character `Lore` and its chat `l1` (one user message `m1`), and loads the wrapper. */
async function boot(messages = [message("m1", "user", "nothing")], characterFields: Record<string, unknown> = {}) {
    vi.resetModules();
    hooks.parse = (text) => text;
    hooks.tokenized = [];
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { characterStore, selectionModule, activePersona } = booted;
    activePersona.name = "User";
    const chaId = characterStore.addCharacter({
        type: "character",
        name: "Lore",
        chats: [{ id: "l1", name: "L1", note: "", localLore: [], message: messages, fmIndex: -1 }],
        chatPage: 0,
        globalLore: [],
        ...characterFields,
    });
    selectionModule.selectCharacter(chaId);
    const ref = { chaId, chatId: "l1" };
    const lorebook = await import("./lorebook.svelte");
    const chatVar = await import("../parser/chatVar.svelte");
    const sources = async (chatRef = ref) =>
        (await lorebook.loadLoreBookV3Prompt(chatRef)).actives.map((a) => a.source);
    return { ...booted, chaId, ref, lorebook, chatVar, sources };
}

beforeAll(async () => {
    await import("../stores.svelte");
    await import("../storage/database.svelte");
}, 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "log").mockImplementation(() => {});
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

describe("loadLoreBookV3Prompt (the client wrapper)", () => {
    it("searches plain keys without yielding: a message change queued before the call is not seen by any entry", async () => {
        const { characterStore, chat, chaId, ref, sources } = await boot();
        characterStore.updateCharacter(chaId, {
            globalLore: [lore("missing", "missing", "m"), lore("dragon", "dragon", "d")],
        });
        queueMicrotask(() => chat.setMessageText(ref, "m1", "dragon"));
        expect(await sources()).toEqual([]);
        // The write landed after the search; the next activation sees it.
        expect(chat.findChat(ref)?.message[0].data).toBe("dragon");
        expect(await sources()).toEqual(["dragon"]);
    }, 30_000);

    it("yields first at the first active's token count, after its CBS and chat-variable reads", async () => {
        const { characterStore, chatVar, chaId, ref, lorebook } = await boot([message("m1", "user", "alpha beta")]);
        characterStore.updateCharacter(chaId, {
            globalLore: [lore("alpha", "alpha", "A {{getvar::x}}"), lore("beta", "beta", "B {{getvar::x}}")],
        });
        chatVar.setChatVarOf(ref, "x", "one");
        hooks.parse = (text) => text.replaceAll("{{getvar::x}}", chatVar.getChatVarOf(ref, "x"));
        queueMicrotask(() => chatVar.setChatVarOf(ref, "x", "two"));
        const result = await lorebook.loadLoreBookV3Prompt(ref);
        // alpha's expansion ran synchronously ("one"); beta's after the first tokenize yielded ("two").
        expect(hooks.tokenized).toEqual(["A one", "B two"]);
        expect(result.actives.map((a) => [a.source, a.prompt, a.tokens])).toEqual([
            ["beta", "B {{getvar::x}}", "B two".length],
            ["alpha", "A {{getvar::x}}", "A one".length],
        ]);
    }, 30_000);

    it("matches regex keys with the fixed grammar: empty flags, the i flag, and an invalid pattern that matches nothing", async () => {
        const { characterStore, chaId, ref, lorebook } = await boot([message("m1", "user", "A dragon appears.")]);
        characterStore.updateCharacter(chaId, {
            globalLore: [
                lore("bad", "/(dragon/", "b", { useRegex: true }),
                lore("empty", "/dragon/", "e", { useRegex: true }),
                lore("iflag", "/DRAGON/i", "i", { useRegex: true }),
                lore("caseful", "/DRAGON/", "c", { useRegex: true }),
                lore("plain", "dragon", "p"),
            ],
        });
        const result = await lorebook.loadLoreBookV3Prompt(ref);
        expect(result.actives.map((a) => a.source)).toEqual(["plain", "iflag", "empty"]);
        expect(result.matchLog).toEqual([
            { prompt: "\x01{{User}}:A dragon appears.\x01", source: "message 0 by user", activated: "/dragon/" },
            { prompt: "\x01{{User}}:A dragon appears.\x01", source: "message 0 by user", activated: "/DRAGON/i" },
            { prompt: "\x01{{user}}:a dragon appears.\x01", source: "message 0 by user", activated: "dragon" },
        ]);
    }, 30_000);

    it("scans the user's messages under the bound persona's name, else the selected persona's, else User", async () => {
        const { characterStore, collectionStore, chat, chaId, ref, lorebook, activePersona, settingsViews } =
            await boot([message("m1", "user", "a dragon")]);
        characterStore.updateCharacter(chaId, { globalLore: [lore("rx", "/dragon/", "d", { useRegex: true })] });
        const prompt = async () => (await lorebook.loadLoreBookV3Prompt(ref)).matchLog[0].prompt;
        expect(await prompt()).toBe("\x01{{User}}:a dragon\x01");
        const personaId = collectionStore.addPersona({ name: "Mina", personaPrompt: "", icon: "" });
        chat.setChatMeta(ref, { bindedPersona: personaId });
        // The persona view follows the selected chat's binding (`docs/plan/chat-binding.md`, slice 4);
        // the tab's own persona is unchanged.
        expect(activePersona.name).toBe("Mina");
        expect(settingsViews.tabPersonaRecord()?.name).toBe("User");
        expect(await prompt()).toBe("\x01{{Mina}}:a dragon\x01");
        chat.setChatMeta(ref, {}, ["bindedPersona"]);
        expect(activePersona.name).toBe("User");
        activePersona.name = undefined as any;
        expect(await prompt()).toBe("\x01{{User}}:a dragon\x01");
    }, 30_000);

    it("merges the module lore enabled globally, on the chat, on the character, and by moduleIntergration, in module order", async () => {
        const { characterStore, collectionStore, chat, chaId, ref, sources, activePreset } = await boot([
            message("m1", "user", "g c h i n"),
        ]);
        for (const id of ["g", "c", "h", "i", "n"]) {
            collectionStore.addModule(module(id, id));
        }
        collectionStore.setEnabledModules(["g"]);
        chat.setChatMeta(ref, { modules: ["c"] });
        characterStore.updateCharacter(chaId, { modules: ["h"] });
        activePreset.moduleIntergration = "i";
        // The module lore follows the character's and the chat's; the result is reversed.
        expect(await sources()).toEqual(["lore-i", "lore-h", "lore-c", "lore-g"]);
        collectionStore.setEnabledModules([]);
        expect(await sources()).toEqual(["lore-i", "lore-h", "lore-c"]);
    }, 30_000);

    it("resolves a bound persona's embedded module through the module list, as before the move (inherited)", async () => {
        const { collectionStore, chat, ref, sources } = await boot([message("m1", "user", "mina")]);
        const embedded = { ...module("$embedded", "mina"), name: "Mina's module" };
        const personaId = collectionStore.addPersona({
            name: "Mina",
            personaPrompt: "",
            icon: "",
            embeddedModule: embedded,
        });
        chat.setChatMeta(ref, { bindedPersona: personaId });
        // `getModules` concatenates the embedded module's id but resolves ids over `db.modules`
        // only, so the embedded lore joins once a module with that id is in the list.
        expect(await sources()).toEqual([]);
        collectionStore.addModule(module("other", "zzz"));
        collectionStore.addModule(embedded);
        // `getModules` caches by the joined id list: enabling another module changes the list.
        collectionStore.setEnabledModules(["other"]);
        expect(await sources()).toEqual(["lore-$embedded"]);
    }, 30_000);

    it("writes the keep-after-match flag to the chat through the chat module, and reads it back next time", async () => {
        const { characterStore, chat, chaId, ref, sources } = await boot([message("m1", "user", "a dragon")]);
        characterStore.updateCharacter(chaId, {
            globalLore: [lore("keep", "dragon", "@@keep_activate_after_match\nk", { id: "keep-id" })],
        });
        expect(await sources()).toEqual(["keep"]);
        expect(chat.findChat(ref)?.scriptstate).toEqual({ "$__internal_ka_keep-id": "true" });
        chat.setMessageText(ref, "m1", "nothing");
        expect(await sources()).toEqual(["keep"]);
    }, 30_000);

    it("a group chat scans the group's own lore and names a member message by its speaker", async () => {
        const { characterStore, lorebook } = await boot();
        characterStore.addCharacter({ type: "character", name: "Member", chaId: "member", chats: [], globalLore: [] });
        const groupId = characterStore.addCharacter({
            type: "group",
            name: "Party",
            characters: ["member"],
            chats: [
                {
                    id: "g1",
                    name: "G1",
                    note: "",
                    localLore: [],
                    message: [message("gm1", "char", "a dragon", { saying: "member" })],
                    fmIndex: -1,
                },
            ],
            chatPage: 0,
            globalLore: [lore("group-lore", "/dragon/", "Group lore", { useRegex: true })],
        });
        const result = await lorebook.loadLoreBookV3Prompt({ chaId: groupId, chatId: "g1" });
        expect(result.actives.map((a) => [a.source, a.prompt])).toEqual([["group-lore", "Group lore"]]);
        expect(result.matchLog).toEqual([
            { prompt: "\x01{{Member}}:a dragon\x01", source: "message 0 by char", activated: "/dragon/" },
        ]);
    }, 30_000);
});
