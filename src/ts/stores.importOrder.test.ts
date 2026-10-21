import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmModules } from "./storage/tests/mutationStoresHarness";

// `stores.svelte.ts` and `parser/transformClient.ts` import each other, and `stores.svelte.ts`
// subscribes to `ReloadGUIPointer` while it evaluates (a Svelte store calls a new subscriber at once).
// When `transformClient` is the module evaluated first, it is still initializing when `stores.svelte`
// runs, so that first call must not reach `resetTransformEffects` (its `appliedEmotions` set is in its
// temporal dead zone: `ReferenceError: Cannot access 'appliedEmotions' before initialization`). Every
// later change of the pointer must still run the subscriber: the chat pointer is reset (the observable
// half of the callback; `resetTransformEffects` runs in the same statement list). Both modules are
// real here; everything they reach is mocked, and each case starts from a fresh module registry.

vi.mock("./storage/characterStore.svelte", () => ({ selectedCharacter: () => null }));
vi.mock("./storage/chatStore.svelte", () => ({
    selectedChat: () => null,
    currentChatRef: () => null,
    findChat: () => undefined,
    heldChatRevision: () => null,
    isMessageLocked: () => false,
}));
vi.mock("./storage/settingsViews.svelte", () => ({
    settings: { modules: [], enabledModules: [] },
    activePreset: { id: "preset", moduleIntergration: "" },
    activePersona: { id: "persona" },
}));
vi.mock("./process/modules", () => ({ moduleUpdate: vi.fn() }));
vi.mock("./parser/parser.svelte", () => ({}));
vi.mock("./alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lang", () => ({ language: {} }));
vi.mock("./network/generationJobs", () => ({ generationClientId: () => "client" }));
vi.mock("./plugins/apiV3/pluginContext", () => ({ capturePluginContext: () => undefined, invokeHook: vi.fn() }));
vi.mock("./plugins/pluginHooks", () => ({ pluginHooks: {} }));
vi.mock("./storage/serverAuth", () => ({ authFetch: vi.fn() }));
vi.mock("./storage/resourceClient", () => ({ epochMismatch: () => false, getResourceEpoch: () => "" }));
vi.mock("./util", () => ({ checkPersonaBinded: () => undefined }));

type Stores = typeof import("./stores.svelte");
type TransformClient = typeof import("./parser/transformClient");

/** The subscriber's observable effect: `ReloadChatPointer` is set to a fresh object on each pointer change. */
function chatPointerChanges(stores: Stores, change: () => void): unknown[] {
    const seen: unknown[] = [];
    const off = stores.ReloadChatPointer.subscribe((value) => seen.push(value));
    try {
        // The subscription's own first call.
        expect(seen).toHaveLength(1);
        change();
    } finally {
        off();
    }
    return seen.slice(1);
}

// Transforms both modules once, outside the timed cases. Each case still starts from a fresh registry
// (`resetModules` below), so it evaluates both modules again in its own order: the instance loaded
// here does not take part in either case's order.
beforeAll(
    () => warmModules(() => Promise.all([import("./stores.svelte"), import("./parser/transformClient")])),
    60_000,
);

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.resetModules();
});

describe("the ReloadGUIPointer subscriber of stores.svelte", () => {
    it("lets transformClient be the first module evaluated, and still runs on every later pointer change", async () => {
        // `transformClient` first: `stores.svelte` evaluates inside its import, before its bindings exist.
        const transform: TransformClient = await import("./parser/transformClient");
        expect(typeof transform.resetTransformEffects).toBe("function");
        const stores: Stores = await import("./stores.svelte");

        const changes = chatPointerChanges(stores, () => {
            stores.ReloadGUIPointer.update((n) => n + 1);
            stores.ReloadGUIPointer.update((n) => n + 1);
        });
        expect(changes).toEqual([{}, {}]);
        expect(changes[0]).not.toBe(changes[1]);
    });

    it("runs on every pointer change when stores.svelte is evaluated first, as the app loads it", async () => {
        const stores: Stores = await import("./stores.svelte");
        await import("./parser/transformClient");

        const changes = chatPointerChanges(stores, () => stores.ReloadGUIPointer.set(7));
        expect(changes).toEqual([{}]);
        // A set to the same value is no change for a store: the subscriber does not run.
        expect(chatPointerChanges(stores, () => stores.ReloadGUIPointer.set(7))).toEqual([]);
    });
});
