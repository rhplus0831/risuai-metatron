import { readFileSync } from "node:fs";
import path from "node:path";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain, refJ, refK } from "./mutationStoresHarness";

// The persona module links (`RisuPersona.modules`) on the tab, over the real stores
// (`mutationStoresHarness.ts`: character `c` with chats `k` and `j`): `getModules` adds the links of
// the chat's bound persona only (`checkPersonaBinded`; never the tab's selected persona), by id only
// (never by namespace, never an MCP module), each module once in stored order, for the selected chat
// and for a chat passed by ref; a link change is seen at once (the cache keys the links apart from
// the legacy id lists, and the legacy lists apart from each other); `moduleUpdate` clears the
// background embedding when the last module with one is unlinked; `updatePersona` stores the
// canonical links and the server text equals the mirror. The server's `jobModules` answers the
// same lists for the same data (`server/src/tests/jobModules.test.ts`).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("../../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("../../process/index.svelte", () => ({ doingChat: { set: vi.fn(), subscribe: vi.fn() } }));
vi.mock("../../translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("../../process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("../../process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("../../tokenizer", () => ({ tokenize: vi.fn(async (text: string) => text.length) }));
vi.mock("../../rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "../../rpack/rpack_map.bin")));
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(map.slice(0, 256)), decodeRPack: apply(map.slice(256, 512)) };
});

/**
 * Boots the stores with persona `Mina` added (linking `plain` twice, `global`, a namespace text, an
 * MCP module, and a missing id), the modules below installed, `global` enabled, chat `k` bound to
 * Mina and chat `j` unbound with `shared-ns` in its own module list. The character is selected with
 * chat `k`.
 */
async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { collectionStore, chat, selectionModule, settingsViews } = booted;
    const tabPersonaId = settingsViews.activePersona.id!;
    const minaId = collectionStore.addPersona({
        name: "Mina",
        personaPrompt: "the mina",
        icon: "mina-icon",
        modules: ["plain", "plain", "global", "missing", "shared-ns", "mcpmod"],
    });
    for (const module of [
        { id: "global", name: "Global" },
        { id: "plain", name: "Plain", backgroundEmbedding: "<bg/>" },
        { id: "nsmod", name: "Namespaced", namespace: "shared-ns" },
        { id: "mcpmod", name: "Mcp", mcp: { url: "http://mcp" } },
        { id: "a-b", name: "Dash" },
        { id: "a", name: "A" },
        { id: "b", name: "B" },
    ]) {
        collectionStore.addModule({ description: "", ...module });
    }
    collectionStore.setEnabledModules(["global"]);
    chat.setChatMeta(refJ, { modules: ["shared-ns"] });
    const binding = await import("../chatBinding.svelte");
    binding.chatBindingPatch(refK, { personaId: minaId });
    selectionModule.selectCharacter("c");
    chat.selectChat("c", "k");
    const modules = await import("../../process/modules");
    const ids = (chatRef?: { chaId: string; chatId: string }) => modules.getModules(chatRef).map((entry) => entry.id);
    return { ...booted, binding, modules, ids, tabPersonaId, minaId };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    server.current?.close();
});

describe("getModules with persona module links", () => {
    it("adds the bound persona's links by id only, once each, in stored order, MCP modules excepted; the legacy lists still match namespaces", async () => {
        const { ids, settings, minaId, collectionStore } = await boot();
        // `addPersona` stored the canonical links.
        expect(plain(settings.personas.find((persona) => persona.id === minaId)?.modules)).toEqual([
            "plain",
            "global",
            "missing",
            "shared-ns",
            "mcpmod",
        ]);
        // Stored order (`global` before `plain`); `shared-ns` (a namespace), `mcpmod` (MCP), and
        // `missing` contribute nothing; `global` (enabled and linked) and `plain` (linked twice) once.
        expect(ids()).toEqual(["global", "plain"]);
        expect(ids(refK)).toEqual(["global", "plain"]);
        // Chat `j` is unbound: no links, and its own `shared-ns` resolves the namespaced module.
        expect(ids(refJ)).toEqual(["global", "nsmod"]);
        // An MCP module named by a legacy list resolves: only the persona path excludes it.
        collectionStore.setEnabledModules(["global", "mcpmod"]);
        expect(ids(refK)).toEqual(["global", "plain", "mcpmod"]);
    });

    it("counts only the chat's bound persona: not the tab's selection, not an unbound chat, not a deleted persona", async () => {
        const { ids, chat, binding, collectionStore, settings, tabPersonaId, minaId, activePersona } = await boot();
        // At `j` (unbound) the view shows the tab's persona; its links never activate.
        chat.selectChat("c", "j");
        expect(activePersona.id).toBe(tabPersonaId);
        collectionStore.updatePersona(tabPersonaId, { modules: ["plain"] });
        expect(ids()).toEqual(["global", "nsmod"]);
        expect(ids(refJ)).toEqual(["global", "nsmod"]);
        // Mina's links still follow the chat bound to her, selected or not.
        expect(ids(refK)).toEqual(["global", "plain"]);
        chat.selectChat("c", "k");
        expect(ids()).toEqual(["global", "plain"]);

        // Unbinding `k` drops the links; binding again restores them.
        binding.chatBindingPatch(refK, { personaId: null });
        expect(ids()).toEqual(["global"]);
        expect(ids(refK)).toEqual(["global"]);
        binding.chatBindingPatch(refK, { personaId: minaId });
        expect(ids(refK)).toEqual(["global", "plain"]);

        // Deleting Mina leaves `k` bound to a persona that is gone: no links (and no fallback to the tab's).
        collectionStore.setPersonas(plain(settings.personas).filter((persona: any) => persona.id !== minaId));
        expect(ids()).toEqual(["global"]);
        expect(ids(refK)).toEqual(["global"]);
    });

    it("sees a link change at once, through a mutation or a write to the record, and keys the links apart from the legacy ids", async () => {
        const { ids, settings, collectionStore, minaId } = await boot();
        // A linked text that is a namespace resolves nothing...
        collectionStore.updatePersona(minaId, { modules: ["shared-ns"] });
        expect(ids(refK)).toEqual(["global"]);
        // ...while the same enabled text resolves the module (with the old joined key, `global` +
        // `shared-ns` in either source read as one key and the first answer would have been served).
        collectionStore.updatePersona(minaId, { modules: [] });
        collectionStore.setEnabledModules(["global", "shared-ns"]);
        expect(ids(refK)).toEqual(["global", "nsmod"]);
        collectionStore.setEnabledModules(["global"]);
        expect(ids(refK)).toEqual(["global"]);

        // The persona editor writes the record itself (as `largePortrait` is written).
        const mina = settings.personas.find((persona) => persona.id === minaId)!;
        mina.modules = [...(mina.modules ?? []), "plain"];
        expect(ids(refK)).toEqual(["global", "plain"]);
        mina.modules = mina.modules!.filter((id) => id !== "plain");
        expect(ids(refK)).toEqual(["global"]);

        // The legacy ids are keyed as a list, not a joined text: `a-b` and `a`,`b` are different keys.
        collectionStore.setEnabledModules(["a-b"]);
        expect(ids(refK)).toEqual(["a-b"]);
        collectionStore.setEnabledModules(["a", "b"]);
        expect(ids(refK)).toEqual(["a", "b"]);
    });

    it("a tracked read of getModules follows a link change by itself: the module effect needs no explicit dependency on the links", async () => {
        const { ids, settings, collectionStore, binding, minaId } = await boot();
        // The probe and the flush after the boot's `vi.resetModules()`, in the stores' module
        // generation: a `flushSync` imported before it flushes another runtime instance's queue.
        const { createProbe } = await import("./reactiveProbe.svelte");
        const { flushSync } = await import("svelte");
        // As the `$effect` in `stores.svelte.ts` (`moduleUpdate`) reads the links: through `getModules`.
        const probe = createProbe(() => ids());
        expect(probe.seen).toEqual([["global", "plain"]]);
        collectionStore.updatePersona(minaId, { modules: [] });
        flushSync();
        expect(probe.seen.at(-1)).toEqual(["global"]);
        // The persona editor's write to the record is seen too.
        const mina = settings.personas.find((persona) => persona.id === minaId)!;
        mina.modules = ["plain"];
        flushSync();
        expect(probe.seen.at(-1)).toEqual(["global", "plain"]);
        // And a binding change.
        binding.chatBindingPatch(refK, { personaId: null });
        flushSync();
        expect(probe.seen.at(-1)).toEqual(["global"]);
        probe.dispose();
    });

    it("moduleUpdate clears the background embedding when the last module with one is unlinked", async () => {
        const { modules, stores, collectionStore, minaId } = await boot();
        modules.moduleUpdate();
        expect(get(stores.moduleBackgroundEmbedding)).toBe("\n<bg/>\n");
        collectionStore.updatePersona(minaId, { modules: [] });
        modules.moduleUpdate();
        expect(get(stores.moduleBackgroundEmbedding)).toBe("");
        collectionStore.updatePersona(minaId, { modules: ["plain"] });
        modules.moduleUpdate();
        expect(get(stores.moduleBackgroundEmbedding)).toBe("\n<bg/>\n");
    });
});

describe("updatePersona with modules", () => {
    it("refuses a non-list and a list with a non-string, stores the canonical links, removes the field on undefined, and the server text equals the mirror", async () => {
        const { sync, collectionStore, record, settings, refused, validation, minaId } = await boot();
        const mina = () => plain(settings.personas.find((persona) => persona.id === minaId));
        const stored = () => record("personas").find((persona: any) => persona.id === minaId);
        // The boot's writes saved first: `refused` compares the server text across its own flush.
        await sync.flushResources();
        expect(stored().modules).toEqual(["plain", "global", "missing", "shared-ns", "mcpmod"]);
        expect(record("personas")).toEqual(plain(settings.personas));
        await refused(
            () => collectionStore.updatePersona(minaId, { modules: "plain" }),
            validation.MutationValidationError,
        );
        await refused(
            () => collectionStore.updatePersona(minaId, { modules: ["plain", 1] }),
            validation.MutationValidationError,
        );
        await refused(
            () => collectionStore.updatePersona(minaId, { modules: null }),
            validation.MutationValidationError,
        );

        collectionStore.updatePersona(minaId, { modules: ["b", "a", "b", " ", "", "a"] });
        expect(mina().modules).toEqual(["b", "a"]);
        await sync.flushResources();
        expect(stored().modules).toEqual(["b", "a"]);
        // The server's normalized text is the client's projection.
        expect(record("personas")).toEqual(plain(settings.personas));

        collectionStore.updatePersona(minaId, { modules: [] });
        expect(mina().modules).toEqual([]);
        await sync.flushResources();
        expect(stored().modules).toEqual([]);

        collectionStore.updatePersona(minaId, { modules: undefined });
        expect(mina()).not.toHaveProperty("modules");
        await sync.flushResources();
        expect(stored()).not.toHaveProperty("modules");
        expect(record("personas")).toEqual(plain(settings.personas));
    });
});
