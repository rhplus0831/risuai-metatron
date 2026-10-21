import { tick } from "svelte";
import { expect, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { StoreBackedServer } from "./storeBackedServer";

/**
 * The boot shared by the mutation store tests (`characterStore.test.ts`, `collectionStore.test.ts`,
 * `pluginStorageStore.test.ts`, `mutationScope.test.ts`): the real server store in memory with two
 * prompt presets, two model presets, one plugin, and a character `c` with chats `k` (messages a, b, c) and `j` (empty), read,
 * seeded, installed into the records through the real boot (`installBootRecords`: the records and
 * the selection, at home), the chat module initialized, and the adapter started with its boot pass done. The
 * test file declares the module mocks (`vi.mock` is per file), calls `vi.resetModules()` first, and
 * installs the server through `install` (its hoisted holder for the `authFetch` mock).
 */

export const KINDS = Object.values(RESOURCE_KIND);
export const m = (id: string | undefined, data: string, role: "user" | "char" = "user") =>
    ({ role, data, chatId: id }) as any;
export const refK = { chaId: "c", chatId: "k" };
export const refJ = { chaId: "c", chatId: "j" };
/** A plain copy of a mirror value (a Svelte proxy answers `Object.hasOwn` for an own `__proto__` differently). */
export const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/**
 * Loads a test file's module graph once: `load` performs the imports (the caller passes them, so
 * their paths are relative to it). A test file calls it in a `beforeAll` with a 60 s hook timeout
 * (under its own mocks), so the cold transform is paid outside every timed test. Each test still
 * calls `vi.resetModules()` and evaluates fresh modules; the instance loaded here is left behind as
 * each test's own is for the next one. The effects the evaluation queued run, then the mock calls
 * made while loading are cleared.
 */
export async function warmModules(load: () => Promise<unknown>) {
    await load();
    await tick();
    vi.clearAllMocks();
}

/**
 * `warmModules` over the module graph the storage tests boot: the modules `bootMutations` imports
 * and the server modules behind `StoreBackedServer` and `serverKinds.ts`. `also` loads the file's
 * further modules.
 */
export async function warmMutationGraph(also?: () => Promise<unknown>) {
    await warmModules(() => loadMutationGraph(also));
}

async function loadMutationGraph(also?: () => Promise<unknown>) {
    await Promise.all([
        StoreBackedServer.preload(),
        import("../../stores.svelte"),
        import("../resourceClient"),
        import("../resourceSync.svelte"),
        import("../chatStore.svelte"),
        import("../../bootstrap"),
        import("../settingsViews.svelte"),
        import("../snapshots.svelte"),
        import("../characterStore.svelte"),
        import("../collectionStore.svelte"),
        import("../pluginStorageStore.svelte"),
        import("../characterOrder"),
        import("../selection.svelte"),
        import("../mutationValidation"),
    ]);
    await also?.();
}

export async function bootMutations(install: (server: StoreBackedServer) => void) {
    const fake = await StoreBackedServer.create();
    // The test file's `authFetch` mock reads the server from its hoisted holder: install it first.
    install(fake);
    fake.set("presets", "main", [{ name: "p1" }, { name: "p2" }]);
    fake.set("modelPresets", "main", [{ name: "m1" }, { name: "m2" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", [{ name: "plug", realArg: { a: "1" } }]);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [{ kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "k",
                            name: "K",
                            note: "",
                            localLore: [],
                            message: [m("a", "A", "char"), m("b", "B"), m("c", "C", "char")],
                        } as any,
                    },
                ],
            },
            {
                characterId: "c",
                chatId: "j",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "j", name: "J", note: "", localLore: [], message: [] } as any }],
            },
        ],
    });

    const stores = await import("../../stores.svelte");
    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const chat = await import("../chatStore.svelte");
    const bootstrap = await import("../../bootstrap");
    const settingsViews = await import("../settingsViews.svelte");
    const snapshots = await import("../snapshots.svelte");
    const characterStore = await import("../characterStore.svelte");
    const collectionStore = await import("../collectionStore.svelte");
    const pluginStorageStore = await import("../pluginStorageStore.svelte");
    const characterOrder = await import("../characterOrder");
    const selectionModule = await import("../selection.svelte");
    const validation = await import("../mutationValidation");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    selectionModule.selectCharacter(null);
    chat.initializeChats();
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;

    const { settings, activePreset, activeModelPreset, activePersona } = settingsViews;
    /** The character list's wrapper, loosely typed as the facade's `characters` was (the chat view, `desc`, ...). */
    const characterList = () => characterStore.characterList() as any[];
    /** Everything the server holds, as text: the records of every kind and the chats. */
    const serverText = () => {
        const read = fake.store.readKinds(KINDS.map((kind) => fake.kind(kind)) as unknown[], { chats: true });
        return JSON.stringify({ kinds: read.kinds, chats: read.chats, orders: read.chatOrders });
    };
    /** The mirror as text: the legacy flat shape of the settings (`rootSnapshot`) and the character list (its chat view included). */
    const mirrorText = () => JSON.stringify({ root: snapshots.rootSnapshot(), characters: characterList() });
    /**
     * Runs `mutate`, which must throw an error of `errorClass`, then checks that neither the mirror
     * nor the server changed and that nothing was sent (after a flush, so a stray mark would show).
     */
    const refused = async (mutate: () => unknown, errorClass: new (...args: any[]) => Error) => {
        const mirror = mirrorText();
        const server = serverText();
        const batches = fake.batchCount();
        expect(mutate).toThrow(errorClass);
        expect(mirrorText()).toBe(mirror);
        await sync.flushResources();
        expect(serverText()).toBe(server);
        expect(fake.batchCount()).toBe(batches);
    };
    /**
     * `refused` for a list of mutations: after each, the mirror is as it was before the first, and a
     * flush sends nothing and leaves the server as it was, so a change by any of them shows even when
     * a later one would undo it. The texts before are taken once, not once per mutation.
     */
    const refusedEach = async (mutations: (() => unknown)[], errorClass: new (...args: any[]) => Error) => {
        const mirror = mirrorText();
        const server = serverText();
        const batches = fake.batchCount();
        for (const mutate of mutations) {
            expect(mutate).toThrow(errorClass);
            expect(mirrorText()).toBe(mirror);
            await sync.flushResources();
            expect(serverText()).toBe(server);
            expect(fake.batchCount()).toBe(batches);
        }
    };
    const record = (kind: string, id = "main") => fake.record(kind, id)?.data as any;
    const character = (id: string): any => characterList().find((entry: any) => entry?.chaId === id);
    return {
        fake,
        stores,
        sync,
        chat,
        settingsViews,
        settings,
        activePreset,
        activeModelPreset,
        activePersona,
        snapshots,
        characterStore,
        characterList,
        collectionStore,
        pluginStorageStore,
        characterOrder,
        selection: selectionModule.selection,
        selectionModule,
        validation,
        record,
        character,
        serverText,
        mirrorText,
        refused,
        refusedEach,
    };
}
