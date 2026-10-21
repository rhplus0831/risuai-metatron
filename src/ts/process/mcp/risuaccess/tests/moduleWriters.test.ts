import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain, warmMutationGraph } from "src/ts/storage/tests/mutationStoresHarness";
import type { RPCToolCallContent } from "../../mcplib";

// The RisuAccess module write tools (`modules.ts`) against the real save adapter and the real
// server store (`storeBackedServer.ts`); the read tools are `modules.test.ts`. Every write tool
// patches one field of a fixture module through `updateModule` (and `enabled` through
// `setModuleEnabled`) and is saved by the next cycle; an MCP module, a denied consent, a missing
// entry, a value of the wrong type (`enabled: "false"` is refused, not read as true), and a
// non-data value change nothing and send nothing. The consent gate: the patch is built from the
// module as it is after consent, and a module removed or turned into an MCP module while the prompt
// was open answers "not found" without a write.

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
const fixture = () => ({
    id: "m",
    name: "Mod",
    description: "a module",
    backgroundEmbedding: "<style>x</style>",
    lorebook: [lore("Town", "t", "town")],
    regex: [regex("a"), regex("b")],
    trigger: [luaTrigger("-- old"), { comment: "second", type: "manual", conditions: [], effect: [] }],
});

/** Boots the harness with the fixture module `m` and an MCP module `mcp`, and loads the module handler on that graph. */
async function boot() {
    vi.resetModules();
    consent.prompts.length = 0;
    consent.queue.length = 0;
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { ModuleHandler } = await import("../modules");
    const handler = new ModuleHandler();
    const call = async (tool: string, args: Record<string, unknown>) => text(await handler.handle(tool, args));
    booted.collectionStore.addModule(fixture());
    booted.collectionStore.addModule({
        id: "mcp",
        name: "Remote",
        mcp: { url: "https://mcp.example/sse" },
        lorebook: [],
    });
    await booted.sync.flushResources();
    booted.fake.requests.length = 0;
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
    const savedModule = (id = "m") => booted.record("modules").find((module: any) => module.id === id);
    const module = (id = "m") => booted.collectionStore.findModule(id) as any;
    return { ...booted, handler, call, hold, unchanged, savedModule, module };
}

beforeAll(() => warmMutationGraph(() => import("../modules")), 60_000);

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

describe("write tools", () => {
    it("set-module-info writes the typed fields through updateModule and enabled through the enabled list, skipping unknown keys", async () => {
        const { call, sync, savedModule, record, settings } = await boot();
        expect(
            await call("risu-set-module-info", {
                id: "m",
                data: {
                    name: "Renamed",
                    description: "d",
                    lowLevelAccess: true,
                    backgroundEmbedding: "<style>y</style>",
                    customModuleToggle: "k=v",
                    enabled: true,
                    nope: 1,
                    constructor: "skipped",
                },
            }),
        ).toBe("Successfully updated module Renamed");
        expect(consent.prompts).toEqual([
            'risu-set-module-info is trying to "modify module (Mod) information". Do you want to allow this?',
        ]);
        await sync.flushResources();
        expect(savedModule()).toMatchObject({
            id: "m",
            name: "Renamed",
            description: "d",
            lowLevelAccess: true,
            backgroundEmbedding: "<style>y</style>",
            customModuleToggle: "k=v",
        });
        expect(savedModule()).not.toHaveProperty("nope");
        expect(Object.hasOwn(savedModule(), "constructor")).toBe(false);
        expect(record("enabledModules")).toEqual(["m"]);
        expect(await call("risu-set-module-info", { id: "m", data: { enabled: false } })).toBe(
            "Successfully updated module Renamed",
        );
        await sync.flushResources();
        expect(record("enabledModules")).toEqual([]);
        expect(settings.enabledModules).toEqual([]);
        expect(await call("risu-get-module-info", { id: "m", fields: ["name", "enabled"] })).toBe(
            JSON.stringify({ name: "Renamed", enabled: false }),
        );
    });

    it("the lorebook, regex, and Lua tools patch their one list and keep the rest of the module", async () => {
        const { call, sync, savedModule } = await boot();
        expect(
            await call("risu-set-module-lorebook", {
                id: "m",
                name: "Town",
                content: "city",
                newName: "City",
                alwaysActive: true,
            }),
        ).toBe('Successfully updated lorebook entry "Town" in module Mod');
        expect(await call("risu-set-module-lorebook", { id: "m", name: "New", content: "n", keys: ["k1", "k2"] })).toBe(
            'Successfully added lorebook entry "New" to module Mod',
        );
        expect(
            await call("risu-set-module-regex-script", { id: "m", name: "a", out: "changed", ableFlag: false }),
        ).toBe('Successfully updated regex script "a" in module Mod');
        expect(await call("risu-set-module-regex-script", { id: "m", name: "new", in: "x", out: "y" })).toBe(
            'Successfully added regex script "new" to module Mod',
        );
        expect(await call("risu-delete-module-regex-script", { id: "m", name: "b" })).toBe(
            'Successfully deleted regex script "b" from module Mod',
        );
        expect(await call("risu-set-module-lua-script", { id: "m", code: "-- new" })).toBe(
            "Successfully updated Lua script for module Mod",
        );
        await sync.flushResources();
        const saved = savedModule();
        expect(saved.lorebook).toEqual([
            { ...lore("City", "city", ""), alwaysActive: true },
            lore("New", "n", "k1,k2"),
        ]);
        expect(saved.regex).toEqual([
            { ...regex("a"), out: "changed", ableFlag: false },
            { comment: "new", in: "x", out: "y", type: "editdisplay", flag: "", ableFlag: true },
        ]);
        // The Lua code is replaced in a copy: the other effect, the conditions, and the second trigger survive.
        expect(saved.trigger).toEqual([
            luaTrigger("-- new"),
            { comment: "second", type: "manual", conditions: [], effect: [] },
        ]);
        expect(saved).toMatchObject({ name: "Mod", description: "a module", backgroundEmbedding: "<style>x</style>" });
        expect(await call("risu-delete-module-lorebook", { id: "m", name: "City" })).toBe(
            'Successfully deleted lorebook entry "City" from module Mod',
        );
        await sync.flushResources();
        expect(savedModule().lorebook).toEqual([lore("New", "n", "k1,k2")]);
        expect(await call("risu-get-module-lua-script", { id: "m" })).toBe("-- new");
    });

    it("adds to a module without the list, and the caller's data is detached", async () => {
        const { call, sync, savedModule, collectionStore } = await boot();
        collectionStore.addModule({ id: "bare", name: "Bare" });
        await sync.flushResources();
        const keys = ["k"];
        expect(await call("risu-set-module-lorebook", { id: "bare", name: "L", content: "c", keys })).toBe(
            'Successfully added lorebook entry "L" to module Bare',
        );
        expect(await call("risu-set-module-regex-script", { id: "bare", name: "R" })).toBe(
            'Successfully added regex script "R" to module Bare',
        );
        keys.push("later");
        await sync.flushResources();
        expect(savedModule("bare").lorebook).toEqual([lore("L", "c", "k")]);
        expect(savedModule("bare").regex).toEqual([
            { comment: "R", in: "", out: "", type: "editdisplay", flag: "", ableFlag: true },
        ]);
    });
});

describe("nothing is written", () => {
    const writes: [string, Record<string, unknown>][] = [
        ["risu-set-module-info", { data: { name: "x" } }],
        ["risu-set-module-lorebook", { name: "Town", content: "x" }],
        ["risu-delete-module-lorebook", { name: "Town" }],
        ["risu-set-module-regex-script", { name: "a", out: "x" }],
        ["risu-delete-module-regex-script", { name: "a" }],
        ["risu-set-module-lua-script", { code: "-- x" }],
    ];

    it("to an MCP module or an unknown id, for every write tool, without a prompt", async () => {
        const { call, unchanged } = await boot();
        for (const [tool, args] of writes) {
            expect(await unchanged(() => call(tool, { ...args, id: "mcp" }))).toBe(
                "Error: Module with ID mcp not found.",
            );
            expect(await unchanged(() => call(tool, { ...args, id: "nope" }))).toBe(
                "Error: Module with ID nope not found.",
            );
        }
        expect(consent.prompts).toEqual([]);
    });

    it("when the user denies the consent prompt, for every write tool", async () => {
        const { call, unchanged } = await boot();
        for (const [tool, args] of writes) {
            consent.queue.push(false);
            expect(await unchanged(() => call(tool, { ...args, id: "m" }))).toBe("Access denied by user.");
        }
        expect(consent.prompts).toHaveLength(writes.length);
    });

    it("when the entry or script does not exist, or the first trigger is not Lua", async () => {
        const { call, unchanged, collectionStore, sync } = await boot();
        expect(await unchanged(() => call("risu-delete-module-lorebook", { id: "m", name: "nope" }))).toBe(
            'Error: Lorebook entry with name "nope" not found.',
        );
        expect(await unchanged(() => call("risu-delete-module-regex-script", { id: "m", name: "nope" }))).toBe(
            'Error: Regex script with name "nope" not found.',
        );
        collectionStore.updateModule("m", { trigger: undefined });
        await sync.flushResources();
        expect(await unchanged(() => call("risu-set-module-lua-script", { id: "m", code: "-- x" }))).toBe(
            "Error: User must first change the trigger type to Lua manually.",
        );
    });

    it("when an info field has the wrong type: neither the module nor the enabled list changes", async () => {
        const { call, unchanged, record, settings } = await boot();
        const bad: [Record<string, unknown>, string][] = [
            [{ name: "Changed", enabled: "false" }, "Error: Field enabled must be a boolean."],
            [{ enabled: 1 }, "Error: Field enabled must be a boolean."],
            [{ enabled: null }, "Error: Field enabled must be a boolean."],
            [{ name: 5, enabled: true }, "Error: Field name must be a string."],
            [{ lowLevelAccess: "true" }, "Error: Field lowLevelAccess must be a boolean."],
            [{ description: ["d"] }, "Error: Field description must be a string."],
            [{ enabled: true, customModuleToggle: () => 1 }, "Error: Field customModuleToggle must be a string."],
        ];
        for (const [data, answer] of bad) {
            expect(await unchanged(() => call("risu-set-module-info", { id: "m", data }))).toBe(answer);
        }
        expect(settings.enabledModules).toEqual([]);
        expect(record("enabledModules")).toEqual([]);
    });

    it("when the mutation refuses a non-data value in a list patch", async () => {
        const { call, unchanged } = await boot();
        expect(
            await unchanged(() => call("risu-set-module-lorebook", { id: "m", name: "L", content: 1n as any })),
        ).toMatch(/^Error: lorebook: the value is not JSON data/);
        expect(
            await unchanged(() => call("risu-set-module-regex-script", { id: "m", name: "a", out: () => 1 })),
        ).toMatch(/^Error: regex: the value is not JSON data/);
    });
});

describe("the consent gate", () => {
    it("builds the write from the module as it is after consent: a lorebook replaced while the prompt was open is patched", async () => {
        const { call, hold, collectionStore, sync, savedModule } = await boot();
        const release = hold();
        const pending = call("risu-set-module-lorebook", { id: "m", name: "Added", content: "a" });
        expect(consent.prompts).toHaveLength(1);
        collectionStore.updateModule("m", { lorebook: [lore("Fresh", "f")] });
        release(true);
        expect(await pending).toBe('Successfully added lorebook entry "Added" to module Mod');
        await sync.flushResources();
        expect(savedModule().lorebook).toEqual([lore("Fresh", "f"), lore("Added", "a")]);
    });

    it("leaves no gap between the lookup after consent and the write", async () => {
        const { call, hold, collectionStore, module, sync, savedModule, record } = await boot();
        const release = hold();
        const pending = call("risu-set-module-lorebook", { id: "m", name: "Added", content: "a" });
        let seenAtReplacement: unknown = null;
        // The probe: consent resolves, and the module becomes an MCP module in the very next
        // microtask. With an await between the post-consent lookup and the write, the lore was written
        // into the MCP module.
        release(true);
        queueMicrotask(() => {
            seenAtReplacement = plain(module().lorebook);
            collectionStore.updateModule("m", { lorebook: [], mcp: { url: "internal:test" } });
        });
        expect(await pending).toBe('Successfully added lorebook entry "Added" to module Mod');
        // The write had landed before the microtask ran; the replacement is what remains.
        expect(seenAtReplacement).toEqual([lore("Town", "t", "town"), lore("Added", "a")]);
        await sync.flushResources();
        expect(savedModule()).toMatchObject({ lorebook: [], mcp: { url: "internal:test" } });
        expect(record("modules")).toHaveLength(2);
    });

    it("answers not found for a module removed, or turned into an MCP module, while the prompt was open", async () => {
        const { call, hold, collectionStore, unchanged, sync, savedModule, record } = await boot();
        const releaseMcp = hold();
        const pendingMcp = call("risu-set-module-info", { id: "m", data: { name: "x", enabled: true } });
        collectionStore.updateModule("m", { mcp: { url: "internal:test" } });
        await sync.flushResources();
        expect(
            await unchanged(async () => {
                releaseMcp(true);
                return pendingMcp;
            }),
        ).toBe("Error: Module with ID m not found.");
        expect(savedModule().name).toBe("Mod");
        expect(record("enabledModules")).toEqual([]);
        collectionStore.updateModule("m", { mcp: undefined });
        const releaseRemoved = hold();
        const pendingRemoved = call("risu-set-module-lorebook", { id: "m", name: "X", content: "x" });
        expect(collectionStore.removeModule("m")).toBe(true);
        releaseRemoved(true);
        expect(await pendingRemoved).toBe("Error: Module with ID m not found.");
        await sync.flushResources();
        expect(record("modules").map((entry: any) => entry.id)).toEqual(["mcp"]);
    });
});
