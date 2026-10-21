import { readFileSync } from "node:fs";
import path from "node:path";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, refJ, refK, warmMutationGraph } from "./mutationStoresHarness";

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

import type { RisuModule } from "../../process/modules";

const module = (id: string, extra: Partial<RisuModule> = {}): RisuModule => ({
    id,
    name: id,
    description: "",
    assets: [[id, `assets/${id}.png`, "png"]],
    lorebook: [
        {
            comment: "",
            mode: "normal",
            key: "key",
            content: "before",
            insertorder: 0,
            alwaysActive: false,
            secondkey: "",
            selective: false,
        },
    ],
    trigger: [],
    ...extra,
});

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    booted.collectionStore.setModules([module("a"), module("b"), module("off")]);
    booted.collectionStore.setEnabledModules(["a", "b"]);
    booted.selectionModule.selectCharacter("c");
    booted.chat.selectChat("c", "k");
    const modules = await import("../../process/modules");
    const records = await import("../records.svelte");
    // Import the probe and Svelte after resetModules: they must share the stores' runtime.
    const { createProbe } = await import("./reactiveProbe.svelte");
    const svelte = await import("svelte");
    svelte.flushSync();
    return {
        ...booted,
        modules,
        records,
        createProbe,
        ...svelte,
        ids: () => modules.getModules().map((entry) => entry.id),
    };
}

beforeAll(
    () =>
        warmMutationGraph(() =>
            Promise.all([
                import("./reactiveProbe.svelte"),
                import("../../../lib/Setting/Pages/Module/ModuleChatMenu.svelte"),
            ]),
        ),
    60_000,
);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    server.current?.close();
});

describe("module membership cache", () => {
    it("resolves a remote replacement immediately and wakes tracked readers without reading displaced wrappers", async () => {
        const { fake, sync, modules, ids, createProbe, flushSync } = await boot();
        await sync.flushResources();
        const probe = createProbe(() => modules.getModules());
        try {
            expect(probe.derived().map((m) => m.id)).toEqual(["a", "b"]);
            fake.set("modules", "main", [module("off"), module("b", { name: "new B" })]);
            expect(sync.applyHydration({ kind: "modules", id: "main", ...fake.record("modules", "main")! })).toBe(true);
            expect(ids()).toEqual(["b"]);
            expect(modules.getModules()[0].name).toBe("new B");
            expect(probe.derived().map((m) => m.id)).toEqual(["b"]);
            flushSync();
            expect(probe.seen).toHaveLength(2);
            expect(probe.seen.at(-1)).toBe(modules.getModules());
        } finally {
            probe.dispose();
        }
    });

    it("resolves a remote item patch through the live-update boundary before a flush", async () => {
        const { fake, sync, collectionStore: c, modules, ids, createProbe, flushSync } = await boot();
        c.setEnabledModules(["a", "ns"]);
        await sync.flushResources();
        const probe = createProbe(() => modules.getModules());
        try {
            expect(probe.derived().map((m) => m.id)).toEqual(["a"]);
            const baseRevision = fake.record("modules", "main")!.revision;
            const patch = {
                items: [],
                changes: [{ id: "b", set: { namespace: "ns" }, remove: [] }],
                order: ["off", "b"],
            };
            const revision = fake.store.applyChanges({
                ops: [{ kind: fake.kind("modules"), id: "main", baseRevision, patch }],
            }).results[0].revision!;
            sync.noteRemoteChanges({
                resources: [{ kind: "modules", id: "main", revision, patch: { baseRevision, ...patch } }],
                chats: [],
                chatOrders: [],
            });
            expect(ids()).toEqual(["b"]);
            expect(probe.derived().map((m) => m.id)).toEqual(["b"]);
            flushSync();
            expect(probe.seen).toHaveLength(2);
        } finally {
            probe.dispose();
        }
    });

    it("resolves local replacements, add/remove, wrapper reorder and bulk list writes before a flush", async () => {
        const { collectionStore: c, records, settings, ids, modules, createProbe } = await boot();
        const probe = createProbe(() => modules.getModules());
        const check = (expected: string[]) => {
            expect(ids()).toEqual(expected);
            expect(probe.derived().map((m) => m.id)).toEqual(expected);
            expect(modules.getModules()).toBe(modules.getModules());
        };
        try {
            check(["a", "b"]);
            c.removeModule("a");
            check(["b"]);
            c.addModule(module("a"));
            check(["b", "a"]);
            settings.modules.reverse();
            check(["a", "b"]);
            records.moveRecordListItem(settings.modules, 0, 2);
            check(["b", "a"]);
            records.replaceRecordList(settings.modules, [settings.modules[2], settings.modules[1]]);
            check(["a", "b"]);
            c.setModules([module("b")]);
            check(["b"]);
            records.replaceRecord("modules", [module("a")]);
            check(["a"]);
            // applyRaw is also the final boundary of a remote item patch.
            records.applyRaw("modules", [module("off"), module("b")]);
            check(["b"]);
            c.updateModule("off", { namespace: "a" });
            check(["off", "b"]);
        } finally {
            probe.dispose();
        }
    });

    it("tracks id, namespace and MCP edits synchronously inside a batch, including memo hits", async () => {
        const { collectionStore: c, settings, records, modules, createProbe, flushSync } = await boot();
        const persona = c.addPersona({ name: "linked", icon: "", personaPrompt: "", modules: ["off"] });
        const { chatBindingPatch } = await import("../chatBinding.svelte");
        chatBindingPatch(refK, { personaId: persona });
        c.setEnabledModules(["a", "ns"]);
        const probe = createProbe(() => modules.getModules());
        const read = () => probe.derived().map((m) => m.id);
        try {
            expect(read()).toEqual(["a", "off"]);
            // Reads stay in the batch: batching persistence must not delay invalidation.
            records.batchRecordWrites(() => {
                settings.modules[0].id = "renamed";
                expect(read()).toEqual(["off"]);
                settings.modules[1].namespace = "ns";
                expect(read()).toEqual(["b", "off"]);
                settings.modules[2].mcp = { url: "https://mcp.invalid" };
                expect(read()).toEqual(["b"]);
                delete settings.modules[2].mcp;
                expect(read()).toEqual(["b", "off"]);
                delete settings.modules[1].namespace;
                expect(read()).toEqual(["off"]);
            });
            flushSync();
            expect(probe.seen).toHaveLength(2);
            expect(probe.seen.at(-1)!.map((m) => m.id)).toEqual(["off"]);
        } finally {
            probe.dispose();
        }
    });

    it("keeps membership memoized across lorebook, asset and trigger edits", async () => {
        const { settings, modules, createProbe, flushSync } = await boot();
        const initial = modules.getModules();
        const probe = createProbe(() => modules.getModules());
        try {
            expect(probe.derived()).toBe(initial);
            settings.modules[0].lorebook![0].content = "edited lore";
            settings.modules[0].assets = [["a", "assets/edited.png", "png"]];
            settings.modules[0].trigger = [{ comment: "new", type: "start", conditions: [], effect: [] }];
            expect(modules.getModules()).toBe(initial);
            expect(probe.derived()).toBe(initial);
            flushSync();
            expect(probe.seen).toEqual([initial]);
        } finally {
            probe.dispose();
        }
    });
});

describe("module asset cache", () => {
    it("shares plain tuples per element and stamp, retaining aggregates across other chats and irrelevant edits", async () => {
        const { settings, modules, chat, records, collectionStore: c, createProbe, flushSync } = await boot();
        chat.setChatMeta(refJ, { modules: ["off"] });
        const probe = createProbe(() => modules.getModuleAssets());
        try {
            const first = probe.derived();
            expect(first).toEqual([
                ["a", "assets/a.png", "png"],
                ["b", "assets/b.png", "png"],
            ]);
            expect(records.isRecordWrapper(first)).toBe(false);
            expect(records.isRecordWrapper(first[0])).toBe(false);
            expect(modules.getModuleAssets()).toBe(first);
            modules.getModuleAssets(refJ);
            // An asset list is immutable: every edit replaces it whole.
            settings.modules[2].assets = [["off", "assets/off-edited.png", "png"]];
            settings.modules[0].lorebook![0].content = "lore only";
            expect(modules.getModuleAssets()).toBe(first);
            expect(probe.derived()).toBe(first);
            flushSync();
            settings.modules[0].assets = [["a", "assets/a-edited.png", "png"]];
            const edited = probe.derived();
            expect(edited).not.toBe(first);
            expect(edited).toEqual([
                ["a", "assets/a-edited.png", "png"],
                ["b", "assets/b.png", "png"],
            ]);
            expect(edited[1]).toBe(first[1]);
            expect(first[0][1]).toBe("assets/a.png");
            // The shared copy is the record's frozen list itself, never a wrapper or a JSON copy.
            expect(Object.isFrozen(edited[0])).toBe(true);
            expect(records.moduleFieldPlain(settings.modules[0], "assets")).toBe(settings.modules[0].assets);
            expect(records.isRecordWrapper(settings.modules[0].assets)).toBe(false);
            expect(modules.getModuleAssets()).toBe(edited);
            flushSync();
            expect(probe.seen.at(-1)).toBe(edited);
            records.batchRecordWrites(() => {
                settings.modules[0].assets = [["renamed", "assets/a-edited.png", "png"]];
                expect(probe.derived()[0]).toEqual(["renamed", "assets/a-edited.png", "png"]);
            });
            c.setModules([module("a", { assets: [["replacement", "assets/new.png", "png"]] })]);
            expect(probe.derived()).toEqual([["replacement", "assets/new.png", "png"]]);
            expect(edited[0]).toEqual(["a", "assets/a-edited.png", "png"]);
        } finally {
            probe.dispose();
        }
    });

    it("enables a large module's assets in one flush and reuses their plain copy after toggling", async () => {
        const { collectionStore: c, modules, createProbe, flushSync } = await boot();
        // The reuse is checked by identity, which does not depend on the list's length.
        const count = 5_000;
        c.setEnabledModules([]);
        c.setModules([
            module("large", {
                assets: Array.from({ length: count }, (_, i) => [`image-${i}`, `assets/${i}.png`, "png"]),
            }),
        ]);
        const probe = createProbe(() => modules.getModuleAssets());
        try {
            expect(probe.derived()).toEqual([]);
            c.setEnabledModules(["large"]);
            const first = probe.derived();
            flushSync();
            expect(first).toHaveLength(count);
            expect(first[count - 1]).toEqual([`image-${count - 1}`, `assets/${count - 1}.png`, "png"]);
            c.setEnabledModules([]);
            expect(probe.derived()).toEqual([]);
            flushSync();
            c.setEnabledModules(["large"]);
            flushSync();
            expect(probe.derived()).toBe(first);
        } finally {
            probe.dispose();
        }
    });
});

describe("module reloads", () => {
    it("reloads once for effective chat/character toggles and never for redundant toggles", async () => {
        const { chat, character, modules, stores, collectionStore: c, flushSync } = await boot();
        c.setEnabledModules([]);
        flushSync();
        modules.moduleUpdate();
        let pointer = get(stores.ReloadGUIPointer);
        const check = (delta: number, background: string) => {
            modules.moduleUpdate();
            modules.moduleUpdate();
            flushSync();
            expect(get(stores.ReloadGUIPointer)).toBe(pointer + delta);
            expect(get(stores.moduleBackgroundEmbedding)).toBe(background);
            pointer += delta;
        };
        c.updateModule("a", { backgroundEmbedding: "<bg/>" });
        check(0, "");
        chat.setChatMeta(refK, { modules: ["a"] });
        check(1, "\n<bg/>\n");
        character("c").modules = ["a"];
        check(0, "\n<bg/>\n");
        chat.setChatMeta(refK, { modules: [] });
        check(0, "\n<bg/>\n");
        character("c").modules = [];
        check(1, "");
        character("c").modules = ["a"];
        check(1, "\n<bg/>\n");
        character("c").modules = [];
        check(1, "");
    });

    it("distinguishes hyphenated id lists and duplicate-id element switches when reloading", async () => {
        const { collectionStore: c, modules, stores, flushSync } = await boot();
        c.setModules([module("a-b"), module("a"), module("b")]);
        c.setEnabledModules(["a-b"]);
        modules.moduleUpdate();
        flushSync();
        let pointer = get(stores.ReloadGUIPointer);
        c.setEnabledModules(["a", "b"]);
        modules.moduleUpdate();
        flushSync();
        expect(get(stores.ReloadGUIPointer)).toBe(++pointer);
        c.setModules([
            module("dup", { namespace: "first", backgroundEmbedding: "one" }),
            module("dup", { namespace: "second", backgroundEmbedding: "two" }),
        ]);
        c.setEnabledModules(["first"]);
        modules.moduleUpdate();
        flushSync();
        pointer = get(stores.ReloadGUIPointer);
        c.setEnabledModules(["second"]);
        modules.moduleUpdate();
        flushSync();
        expect(get(stores.ReloadGUIPointer)).toBe(pointer + 1);
        expect(get(stores.moduleBackgroundEmbedding)).toBe("\ntwo\n");
    });

    it("the mounted menu delegates both toggle gestures to one effective-set reload", async () => {
        const { collectionStore: c, stores, modules, flushSync, mount, unmount } = await boot();
        c.setEnabledModules([]);
        flushSync();
        modules.moduleUpdate();
        const Menu = (await import("../../../lib/Setting/Pages/Module/ModuleChatMenu.svelte")).default;
        const target = document.createElement("div");
        document.body.append(target);
        const component = mount(Menu, { target });
        flushSync();
        try {
            const row = [...target.querySelectorAll("span")].find((span) => span.textContent === "a")!.parentElement!;
            const button = row.querySelector("button")!;
            let pointer = get(stores.ReloadGUIPointer);
            const toggle = (event: string, delta: number) => {
                button.dispatchEvent(new MouseEvent(event, { bubbles: true, cancelable: true }));
                flushSync();
                expect(get(stores.ReloadGUIPointer)).toBe(pointer + delta);
                pointer += delta;
            };
            toggle("click", 1);
            toggle("contextmenu", 0);
            toggle("click", 0);
            toggle("contextmenu", 1);
        } finally {
            await unmount(component);
            target.remove();
        }
    });
});
