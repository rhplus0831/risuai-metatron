import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations } from "../storage/tests/mutationStoresHarness";

// Phase 5 baseline capture (`server/src/tests/fixtures/baseline/README.md`, "Defects pinned here"):
// the lore regex key defect of `loadLoreBookV3Prompt` (now `shared/lore/activation.ts`
// `searchMatch`, the `arg.regex` branch), pinned against the client code over the real store,
// scenario by scenario. The browser capture `lore-regex.json` is the "before" evidence (the key
// `/dragon/i` was rewritten to `/dragon` and stored back into `arg.keys[0]`, so it matched only a
// literal `/dragon`, a key with empty flags matched nothing, and a second scanned message made the
// rewritten key's "flags" the pattern text, which threw and ended the search). Slice 4
// (`lore-templates-and-tokens`) fixed the parse (the last `/` separates the pattern from the flags,
// empty flags allowed, no rewrite); the reviewed expected delta `deltas/lore-regex-fix.json` holds
// the scenarios the fix changes, each with its reason, and this file pins the fixed behavior: the
// delta where it has an entry, the capture everywhere else.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
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
    getModuleMcps: vi.fn(() => []),
}));
// The fixture lore has no CBS: the parser is the identity, as the capture's expansion of it was.
vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("../tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Scenario = {
    name: string;
    chatId: string;
    lore: Record<string, unknown>[];
};
type Captured = {
    messages: string[];
    lore: { comment: string; key: string; useRegex: boolean }[];
    actives: { source: string; prompt: string; pos: string; depth: number; role: string }[];
    matchLog: { prompt: string; source: string; activated: string }[];
};

type Delta = Pick<Captured, "actives" | "matchLog"> & { change: string; why: string };

const fixtureDir = resolve(process.cwd(), "server/src/tests/fixtures/baseline");
let scenarios: Scenario[] = [];
let regexCharacter: { chaId: string; chats: { id: string; message: { data: string; role: string }[] }[] };
let captured: Record<string, Captured> = {};
let deltas: Record<string, Delta> = {};

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { characterStore, stores, db } = booted;
    db().username = "User";
    const lorebook = await import("./lorebook.svelte");
    return { ...booted, characterStore, stores, lorebook };
}

beforeAll(async () => {
    const scenario = JSON.parse(await readFile(resolve(fixtureDir, "scenario.json"), "utf8"));
    scenarios = scenario.loreRegex.scenarios;
    regexCharacter = scenario.characters.find((c: { chaId: string }) => c.chaId === scenario.loreRegex.chaId);
    captured = JSON.parse(await readFile(resolve(fixtureDir, "lore-regex.json"), "utf8"));
    deltas = JSON.parse(await readFile(resolve(fixtureDir, "deltas/lore-regex-fix.json"), "utf8")).scenarios;
    await import("../stores.svelte");
    await import("../storage/database.svelte");
    await import("./lorebook.svelte");
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

describe("Phase 5 baseline: lore regex keys (fixed in slice 4)", () => {
    it("the capture covers the expected scenarios", () => {
        expect(scenarios.map((s) => s.name)).toEqual([
            "i-flag-plain-text",
            "empty-flags-plain-text",
            "i-flag-slash-in-text",
            "i-flag-two-messages-match-second",
            "i-flag-two-messages-match-first",
            "two-keys-second-matches",
            "plain-key-control",
        ]);
        expect(Object.keys(captured)).toEqual(scenarios.map((s) => s.name));
        // The browser recorded the defect: the i-flag key did not match the plain text, the key with
        // empty flags matched nothing, and only the literal `/dragon` (in the first scanned message)
        // activated the entry.
        expect(captured["i-flag-plain-text"].actives).toEqual([]);
        expect(captured["empty-flags-plain-text"].actives).toEqual([]);
        expect(captured["i-flag-slash-in-text"].actives.map((a) => a.source)).toEqual(["regex-i"]);
        expect(captured["i-flag-two-messages-match-second"].actives).toEqual([]);
        expect(captured["i-flag-two-messages-match-first"].actives.map((a) => a.source)).toEqual(["regex-i"]);
        expect(captured["two-keys-second-matches"].actives.map((a) => a.source)).toEqual(["regex-two"]);
        expect(captured["plain-key-control"].actives.map((a) => a.source)).toEqual(["plain"]);
    });

    it("the client reproduces every captured scenario over the real store", async () => {
        // The delta names only captured scenarios and changes each one it names: the i-flag key and
        // the empty-flags key now match plain `dragon`, and a second scanned message is tested with
        // the unrewritten key. Everything else stays as the browser captured it.
        expect(Object.keys(deltas)).toEqual([
            "i-flag-plain-text",
            "empty-flags-plain-text",
            "i-flag-two-messages-match-second",
        ]);
        for (const [name, delta] of Object.entries(deltas)) {
            expect(captured[name]).toBeDefined();
            expect({ actives: delta.actives, matchLog: delta.matchLog }).not.toEqual({
                actives: captured[name].actives,
                matchLog: captured[name].matchLog,
            });
        }
        const { characterStore, stores, lorebook, db } = await boot();
        const chaId = characterStore.addCharacter({
            ...regexCharacter,
            chats: regexCharacter.chats.map((chat) => ({ ...chat, message: chat.message.map((m) => ({ ...m })) })),
        });
        stores.selectedCharID.set(db().characters.findIndex((c: any) => c?.chaId === chaId));
        for (const scenario of scenarios) {
            characterStore.updateCharacter(chaId, { globalLore: scenario.lore });
            const ref = { chaId, chatId: scenario.chatId };
            const result = await lorebook.loadLoreBookV3Prompt(ref);
            const got = {
                actives: result.actives.map((a) => ({
                    source: a.source,
                    prompt: a.prompt,
                    pos: a.pos,
                    depth: a.depth,
                    role: a.role,
                })),
                matchLog: result.matchLog,
            };
            const expected = deltas[scenario.name] ?? captured[scenario.name];
            expect({ name: scenario.name, ...got }).toEqual({
                name: scenario.name,
                actives: expected.actives,
                matchLog: expected.matchLog,
            });
        }
    });
});
