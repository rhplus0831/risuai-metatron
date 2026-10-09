// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { defaultHotkeys } from "../../../shared/hotkeys.ts";
import { parseRevisionToken, RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

// Every registered resource kind over the resource routes (the Phase 6 closeout's criterion 2:
// "every collection has a server resource with revision checks, normalization, and route tests").
// One table row per kind of `DEFAULT_RESOURCE_KINDS`, each run against a fresh server: what a
// fresh store holds (a materialized singleton, an absent singleton, or a per-record kind), a write
// on the held revision answered and stored in its normalized form (the expected values are written
// here from the normalizers' rules, not read from the server), the read-back on every read route,
// the revision advancing by one per write, a stale write and a stale batch op refused with 409 and
// the current revision, the batch route persisting, a value the normalizer refuses as a 400 on both
// write routes, and the singleton rules (only `main`, never deleted) against a per-record delete.
// The chats and chat orders, which are not resource kinds, get the same walk through the batch and
// read routes below. The kinds' shape rules themselves are in `kinds.test.ts` and
// `normalize*.test.ts`; the route contract over identity kinds in `resources.test.ts` and
// `resourcesBatch.test.ts`; the `llmSecrets` masking and secret routes in depth in
// `llmSecrets.test.ts`; the chat op semantics in `resourcesChats.test.ts`.

const servers: ResourceTestClient[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server() {
    const s = await createResourceTestClient();
    servers.push(s);
    return s;
}

type Stored = { epoch: string; revision: string; data: unknown };
type Listed = { epoch: string; items: { id: string; revision: string; data: unknown }[] };
type Applied = { epoch: string; results: { kind: string; id: string; revision: string | null }[] };

/** The parts of a revision token (`<epoch>:<seq>:<revision>`). */
function token(revision: string) {
    const parsed = parseRevisionToken(revision);
    if (!parsed) {
        throw new Error(`not a revision token: ${revision}`);
    }
    return parsed;
}

const masked = (set: boolean, hint = "") => ({ set, hint });
const anyString = () => expect.any(String) as unknown as string;

type KindCase = {
    kind: string;
    /** The record id; `main` for a singleton. */
    id?: string;
    /** What a fresh store holds for the kind: a materialized singleton's data, or `null` when nothing exists until a client writes. */
    fresh: unknown;
    checkFresh?: (data: any) => void;
    /** A first write (a PUT on the held revision) and the normalized value the server answers and stores for it. */
    write: unknown;
    stored: unknown;
    /** A second write (a batch op on the new revision) and its stored form. */
    update: unknown;
    updated: unknown;
    checkUpdated?: (data: any) => void;
    /** Keys the stored data must not carry (dropped by the normalizer). */
    absent?: string[];
    /** Substrings the stored JSON must not carry (a credential the normalizer drops). */
    forbidden?: string[];
    /** A value the normalizer refuses, and the 400's message. */
    invalid: unknown;
    refused: string | RegExp;
};

const CASES: KindCase[] = [
    // ---- the Phase 1 kinds ------------------------------------------------------------------
    {
        kind: "presets",
        fresh: [expect.objectContaining({ id: anyString(), name: "New Preset" })],
        // The canonical schema: a wrong-kind field takes its default and a credential is dropped.
        write: [{ id: "p1", name: "One", temperature: "hot", proxyKey: "leak-proxy", openAIKey: "leak-openai" }],
        stored: [expect.objectContaining({ id: "p1", name: "One", temperature: expect.any(Number) })],
        forbidden: ["leak-proxy", "leak-openai"],
        // A repeated id is re-keyed.
        update: [
            { id: "p1", name: "Two" },
            { id: "p1", name: "Three" },
        ],
        updated: [expect.objectContaining({ id: "p1", name: "Two" }), expect.objectContaining({ name: "Three" })],
        checkUpdated: (data) => {
            expect(data[1].id).not.toBe("p1");
            expect(data[1].id).toEqual(expect.any(String));
        },
        invalid: {},
        refused: "presets must be an array of objects",
    },
    {
        kind: "modules",
        fresh: null,
        write: [{ id: "m1", name: "M", description: "", lorebook: [], regex: [], trigger: [] }],
        stored: [{ id: "m1", name: "M", description: "", lorebook: [], regex: [], trigger: [] }],
        update: [
            { id: "m1", name: "M", description: "", lorebook: [], regex: [], trigger: [] },
            { id: "m2", name: "N", description: "d", lorebook: [], regex: [], trigger: [] },
        ],
        updated: [
            { id: "m1", name: "M", description: "", lorebook: [], regex: [], trigger: [] },
            { id: "m2", name: "N", description: "d", lorebook: [], regex: [], trigger: [] },
        ],
        invalid: [{ id: "m2", name: 5 }],
        refused: "modules[0]: a module's name must be a string",
    },
    {
        kind: "plugins",
        fresh: null,
        write: [{ name: "p", displayName: "P", arguments: {} }],
        stored: [{ name: "p", displayName: "P", arguments: {} }],
        update: [],
        updated: [],
        invalid: {},
        refused: "plugins must be an array of objects",
    },
    {
        kind: "pluginStorage",
        fresh: null,
        write: { _pluginStorage: { a: { k: "v" } } },
        stored: { _pluginStorage: { a: { k: "v" } } },
        update: {},
        updated: {},
        invalid: [],
        refused: "pluginStorage must be an object",
    },
    {
        kind: "pluginPermissions",
        fresh: null,
        write: { grants: { hash_perm: true }, lastGrantTime: { p_perm_lastGrantTime: 5 } },
        stored: { grants: { hash_perm: true }, lastGrantTime: { p_perm_lastGrantTime: 5 } },
        update: { grants: {}, lastGrantTime: {} },
        updated: { grants: {}, lastGrantTime: {} },
        invalid: { grants: { x: false }, lastGrantTime: {} },
        refused: "pluginPermissions.grants values must be true",
    },
    {
        kind: "characters",
        id: "c1",
        fresh: null,
        // The shared defaults fill in; the record holds no chats.
        write: { chaId: "c1", name: "Cara" },
        stored: expect.objectContaining({
            chaId: "c1",
            name: "Cara",
            type: "character",
            additionalData: { tag: [], creator: "", character_version: "" },
        }),
        absent: ["chats"],
        update: { chaId: "c1", name: "Cara", desc: "a description" },
        updated: expect.objectContaining({ chaId: "c1", name: "Cara", desc: "a description", type: "character" }),
        invalid: { chaId: "c1", chats: [] },
        refused: "character must not hold chats",
    },
    {
        kind: "inlays",
        id: "assets/inlay_x.png",
        fresh: null,
        write: { name: "x", ext: "png", type: "image", asset: "assets/inlay_x.png", width: 2, height: 3 },
        stored: { name: "x", ext: "png", type: "image", asset: "assets/inlay_x.png", width: 2, height: 3 },
        update: { name: "x", ext: "png", type: "image", asset: "assets/inlay_x.png", width: 4, height: 3 },
        updated: { name: "x", ext: "png", type: "image", asset: "assets/inlay_x.png", width: 4, height: 3 },
        invalid: { name: "x", ext: "png", type: "image", asset: "elsewhere/x.png" },
        refused: "A media inlay needs a resolvable asset key in the assets namespace",
    },
    // ---- the sections ------------------------------------------------------------------------
    {
        kind: "providers",
        fresh: expect.objectContaining({
            requestRetrys: 2,
            loreBookToken: 8000,
            autofillRequestUrl: true,
            additionalParams: [],
        }),
        // A wrong-kind field takes its fresh-boot default; a key outside the section is dropped.
        write: { requestRetrys: "3", additionalParams: [["header::X-Test", "y"]], bogus: 1 },
        stored: expect.objectContaining({ requestRetrys: 2, additionalParams: [["header::X-Test", "y"]] }),
        absent: ["bogus"],
        // A whole-record write: an omitted field is its default again.
        update: { requestRetrys: 5 },
        updated: expect.objectContaining({ requestRetrys: 5, additionalParams: [] }),
        invalid: [],
        refused: "providers must be an object",
    },
    {
        kind: "secrets",
        fresh: expect.objectContaining({
            NAIApiKey: "",
            hypaCustomSettings: { url: "", key: "", model: "" },
            deeplOptions: { key: "", freeApi: false },
        }),
        write: { NAIApiKey: "nai", hypaCustomSettings: { url: "u", key: 5 } },
        stored: expect.objectContaining({ NAIApiKey: "nai", hypaCustomSettings: { url: "u", key: "", model: "" } }),
        update: { NAIApiKey: "nai2" },
        updated: expect.objectContaining({ NAIApiKey: "nai2", hypaCustomSettings: { url: "", key: "", model: "" } }),
        invalid: "x",
        refused: "secrets must be an object",
    },
    {
        kind: "llmSecrets",
        // Write-only: every read is the masked projection.
        fresh: expect.objectContaining({
            openAIKey: masked(false),
            google: { accessToken: masked(false), projectId: "" },
            OaiCompAPIKeys: {},
            credentials: {},
        }),
        write: { google: { projectId: "proj" } },
        stored: expect.objectContaining({
            openAIKey: masked(false),
            google: { accessToken: masked(false), projectId: "proj" },
        }),
        update: { google: { projectId: "proj2" } },
        updated: expect.objectContaining({ google: { accessToken: masked(false), projectId: "proj2" } }),
        invalid: { openAIKey: "sk-leak" },
        refused: /written through \/api\/llm-secrets/,
    },
    {
        kind: "ui",
        fresh: expect.objectContaining({ language: "en", zoomsize: 100, sendWithEnter: true, askRemoval: true }),
        write: { zoomsize: "big", language: "ko", bogus: true },
        stored: expect.objectContaining({ zoomsize: 100, language: "ko" }),
        absent: ["bogus"],
        update: { zoomsize: 80 },
        updated: expect.objectContaining({ zoomsize: 80, language: "en" }),
        invalid: "ui",
        refused: "ui must be an object",
    },
    {
        kind: "memoryTranslateMedia",
        fresh: expect.objectContaining({ loreBookDepth: 5, sdSteps: 30, webUiUrl: "http://127.0.0.1:7860/" }),
        write: { sdSteps: "12", translator: "deepl" },
        stored: expect.objectContaining({ sdSteps: 30, translator: "deepl" }),
        update: { sdSteps: 12 },
        updated: expect.objectContaining({ sdSteps: 12, translator: "" }),
        invalid: [],
        refused: "memoryTranslateMedia must be an object",
    },
    // ---- the collections ---------------------------------------------------------------------
    {
        kind: "modelPresets",
        // Materialized with one default model preset whose main and sub slots name the default
        // profile (`docs/plan/model-profiles.md`, O4).
        fresh: [
            expect.objectContaining({
                id: anyString(),
                name: "New Model Preset",
                mainSlot: { profileId: "default" },
                subSlot: { profileId: "default" },
            }),
        ],
        // The slot choices only: a prompt field, a profile field, a credential, and the old model
        // ids are dropped; a main slot without a profile tag and a wrong kind take their default.
        write: [
            {
                id: "m1",
                name: "One",
                mainSlot: { modelId: "gpt-4o" },
                auxSlots: { memory: { profileId: "p1" }, bogus: { profileId: "p2" } },
                seperateModelsForAxModels: "yes",
                maxContext: 5,
                aiModel: "gpt-4o",
                temperature: 5,
                proxyKey: "leak-proxy",
                proxyCredentialId: "c1",
            },
        ],
        stored: [
            {
                id: "m1",
                name: "One",
                mainSlot: { profileId: "default" },
                subSlot: { profileId: "default" },
                auxSlots: { memory: { profileId: "p1" } },
                seperateModelsForAxModels: false,
            },
        ],
        absent: ["temperature", "proxyKey", "proxyCredentialId", "maxContext", "aiModel"],
        forbidden: ["leak-proxy"],
        // A repeated id is re-keyed; an empty list becomes one default again.
        update: [
            { id: "m1", name: "Two" },
            { id: "m1", name: "Three" },
        ],
        updated: [expect.objectContaining({ id: "m1", name: "Two" }), expect.objectContaining({ name: "Three" })],
        checkUpdated: (data) => {
            expect(data[1].id).not.toBe("m1");
            expect(data[1].id).toEqual(expect.any(String));
        },
        invalid: {},
        refused: "modelPresets must be an array of objects",
    },
    {
        kind: "modelProfiles",
        // Materialized with one default profile (`docs/plan/model-profiles.md`, O4).
        fresh: [expect.objectContaining({ id: "default", name: "New Connection", modelId: anyString() })],
        // The profile fields only: a prompt field, a slot, and an inline key are dropped (O2), a
        // wrong kind takes its default.
        write: [
            {
                id: "p1",
                name: "Opus",
                modelId: "claude-opus",
                credentialId: "c1",
                maxContext: "big",
                temperature: 5,
                mainSlot: { profileId: "p1" },
                proxyKey: "leak-profile-key",
            },
        ],
        stored: [
            expect.objectContaining({
                id: "p1",
                name: "Opus",
                modelId: "claude-opus",
                credentialId: "c1",
                maxContext: expect.any(Number),
            }),
        ],
        absent: ["temperature", "mainSlot", "proxyKey"],
        forbidden: ["leak-profile-key"],
        // A repeated id is re-keyed.
        update: [
            { id: "p1", name: "Two" },
            { id: "p1", name: "Three" },
        ],
        updated: [expect.objectContaining({ id: "p1", name: "Two" }), expect.objectContaining({ name: "Three" })],
        checkUpdated: (data) => {
            expect(data[1].id).not.toBe("p1");
            expect(data[1].id).toEqual(expect.any(String));
        },
        invalid: {},
        refused: "modelProfiles must be an array of objects",
    },
    {
        kind: "loreBook",
        fresh: [{ name: "My First LoreBook", data: [] }],
        write: [{ name: "L", data: [{ key: "k", content: "c" }] }],
        stored: [{ name: "L", data: [{ key: "k", content: "c" }] }],
        // An empty list written stays empty (the default is for a missing record only).
        update: [],
        updated: [],
        invalid: [1],
        refused: "loreBook must be an array of objects",
    },
    {
        kind: "globalscript",
        fresh: [],
        write: [{ comment: "x", in: "a", out: "b", type: "editinput" }],
        stored: [{ comment: "x", in: "a", out: "b", type: "editinput" }],
        update: [],
        updated: [],
        invalid: {},
        refused: "globalscript must be an array of objects",
    },
    {
        kind: "hotkeys",
        fresh: defaultHotkeys,
        // The stored list, then every built-in hotkey whose action it lacks.
        write: [{ key: "x", ctrl: true, alt: false, action: "reroll" }],
        stored: [
            { key: "x", ctrl: true, alt: false, action: "reroll" },
            ...defaultHotkeys.filter((hotkey) => hotkey.action !== "reroll"),
        ],
        update: [],
        updated: defaultHotkeys,
        invalid: "x",
        refused: "hotkeys must be an array of objects",
    },
    {
        kind: "characterOrder",
        fresh: [],
        write: ["c1", { name: "f", data: ["c2"] }],
        stored: ["c1", { name: "f", data: ["c2"] }],
        update: ["c2"],
        updated: ["c2"],
        invalid: [1],
        refused: "characterOrder must be an array of ids and folders",
    },
    {
        kind: "authRefreshes",
        fresh: [],
        write: [{ url: "https://m.test", tokenUrl: "https://m.test/t", refreshToken: "r", clientId: "c" }],
        stored: [{ url: "https://m.test", tokenUrl: "https://m.test/t", refreshToken: "r", clientId: "c" }],
        update: [],
        updated: [],
        invalid: [{ url: 1 }],
        refused: "authRefreshes entries must hold strings",
    },
    {
        kind: "globalChatVariables",
        fresh: {},
        write: { a: "1" },
        stored: { a: "1" },
        update: {},
        updated: {},
        invalid: [],
        refused: "globalChatVariables must be an object",
    },
    {
        kind: "personas",
        fresh: [{ name: "User", personaPrompt: "", icon: "", note: "", largePortrait: false, id: anyString() }],
        // A wrong-typed persona field takes its default; the other keys stay.
        write: [{ name: "P", id: "u1", largePortrait: true, personaPrompt: 5 }],
        stored: [{ name: "P", id: "u1", largePortrait: true, personaPrompt: "", icon: "", note: "" }],
        update: [
            { id: "u1", name: "P" },
            { id: "u1", name: "Q" },
        ],
        updated: [expect.objectContaining({ id: "u1", name: "P" }), expect.objectContaining({ name: "Q" })],
        checkUpdated: (data) => {
            expect(data[1].id).not.toBe("u1");
            expect(data[1].id).toEqual(expect.any(String));
        },
        invalid: [1],
        refused: "personas must be an array of objects",
    },
    {
        kind: "translatorPresets",
        fresh: {
            items: [{ id: anyString(), name: "Default", prompt: "", maxResponse: 1000 }],
            selectedId: anyString(),
        },
        checkFresh: (data) => expect(data.selectedId).toBe(data.items[0].id),
        // A blank name is numbered, a non-number `maxResponse` takes the default, and an unknown
        // `selectedId` falls back to the first item.
        write: { items: [{ id: "t1", name: "", prompt: "p", maxResponse: "x" }], selectedId: "zzz" },
        stored: { items: [{ id: "t1", name: "Preset 1", prompt: "p", maxResponse: 1000 }], selectedId: "t1" },
        update: {
            items: [
                { id: "t1", name: "T" },
                { id: "t2", name: "U", prompt: "q", maxResponse: 5 },
            ],
            selectedId: "t2",
        },
        updated: {
            items: [
                { id: "t1", name: "T", prompt: "", maxResponse: 1000 },
                { id: "t2", name: "U", prompt: "q", maxResponse: 5 },
            ],
            selectedId: "t2",
        },
        invalid: { items: "x" },
        refused: "translatorPresets.items must be an array of objects",
    },
    {
        kind: "hypaV3Presets",
        fresh: {
            items: [
                expect.objectContaining({
                    id: anyString(),
                    name: "Default",
                    settings: expect.objectContaining({ summarizationModel: "subModel", memoryTokensRatio: 0.2 }),
                }),
            ],
            selectedId: anyString(),
        },
        checkFresh: (data) => expect(data.selectedId).toBe(data.items[0].id),
        write: { items: [{ id: "h1", name: "H", settings: { memoryTokensRatio: 0.5 } }], selectedId: "nope" },
        stored: {
            items: [
                expect.objectContaining({
                    id: "h1",
                    name: "H",
                    settings: expect.objectContaining({
                        memoryTokensRatio: 0.5,
                        summarizationModel: "subModel",
                        maxChatsPerSummary: 6,
                    }),
                }),
            ],
            selectedId: "h1",
        },
        // An empty list becomes one default item, which the selection then names.
        update: { items: [], selectedId: "h1" },
        updated: { items: [expect.objectContaining({ id: anyString(), name: "Default" })], selectedId: anyString() },
        checkUpdated: (data) => expect(data.selectedId).toBe(data.items[0].id),
        invalid: [],
        refused: "hypaV3Presets must be an object",
    },
    {
        kind: "customModels",
        fresh: [],
        // A custom model holds no key or key binding (`docs/plan/model-profiles.md`, O2): either is dropped.
        write: [{ id: "m1", internalId: "i1", name: "M", key: "secret-model-key", credentialId: "c1" }],
        stored: [{ id: "m1", internalId: "i1", name: "M" }],
        forbidden: ["secret-model-key"],
        update: [],
        updated: [],
        invalid: [{ id: "m" }],
        refused: "customModels entries need string id and internalId",
    },
    {
        kind: "credentials",
        fresh: [],
        // A key's value is an `llmSecrets` credential, and only a Vertex key keeps its client email.
        write: [
            { id: "c1", name: "Work", type: "openai", key: "secret-named-key", clientEmail: "dropped@example.test" },
            { id: "c2", name: "Service", type: "vertex", clientEmail: "sa@example.test" },
        ],
        stored: [
            { id: "c1", name: "Work", type: "openai" },
            { id: "c2", name: "Service", type: "vertex", clientEmail: "sa@example.test" },
        ],
        forbidden: ["secret-named-key", "dropped@example.test"],
        update: [],
        updated: [],
        invalid: [{ id: "c1", name: "Unknown", type: "aws" }],
        refused: "credentials entries need a record id, string name and known type",
    },
    {
        kind: "enabledModules",
        fresh: [],
        write: ["m1"],
        stored: ["m1"],
        update: [],
        updated: [],
        invalid: [1],
        refused: "enabledModules must be an array of strings",
    },
    {
        kind: "statics",
        fresh: { messages: 0, imports: 0 },
        // A non-number counter is 0.
        write: { messages: "5", imports: 2 },
        stored: { messages: 0, imports: 2 },
        update: { messages: 7, imports: 2 },
        updated: { messages: 7, imports: 2 },
        invalid: [],
        refused: "statics must be an object",
    },
];

describe("every registered kind over the resource routes", () => {
    it("the table names every registered kind, and the registry names every shared kind", () => {
        const registered = DEFAULT_RESOURCE_KINDS.map((kind) => kind.name).sort();
        expect(CASES.map((c) => c.kind).sort()).toEqual(registered);
        expect(Object.values(RESOURCE_KIND).sort()).toEqual(registered);
    });

    for (const c of CASES) {
        const kind = DEFAULT_RESOURCE_KINDS.find((candidate) => candidate.name === c.kind);
        const id = c.id ?? SINGLETON_RESOURCE_ID;
        const shape = kind?.materialize
            ? "a materialized singleton"
            : kind?.singleton
              ? "an absent singleton"
              : "a per-record kind";
        it(`${c.kind} (${shape}): normalized on write, read back everywhere, revision advanced, stale writes 409, batch persisted, bad values 400`, async () => {
            expect(kind).toBeDefined();
            const s = await server();

            // The fresh store: a materialized singleton exists with its fresh-boot value; anything
            // else is absent until a client writes it.
            const fresh = (await (await s.list(c.kind)).json()) as Listed;
            expect(fresh.epoch).toBe(s.epoch);
            const before = await s.get(c.kind, id);
            let base: string | null;
            if (c.fresh === null) {
                expect(kind!.materialize).toBeUndefined();
                expect(fresh.items).toEqual([]);
                expect(before.status).toBe(404);
                base = null;
            } else {
                expect(kind!.materialize).toBe(true);
                expect(fresh.items).toEqual([{ id, revision: expect.any(String), data: c.fresh }]);
                expect(before.status).toBe(200);
                expect(await before.json()).toEqual({
                    epoch: s.epoch,
                    revision: fresh.items[0].revision,
                    data: c.fresh,
                });
                c.checkFresh?.(fresh.items[0].data);
                base = fresh.items[0].revision;
            }

            // A write on the held revision (null to create): the normalized value is answered and
            // stored, and the revision is 1 for a new record or the held one plus one.
            const put = await s.put(c.kind, id, { baseRevision: base, data: c.write });
            expect(put.status, await put.clone().text()).toBe(200);
            const first = (await put.json()) as Stored;
            expect(first.epoch).toBe(s.epoch);
            expect(first.data).toEqual(c.stored);
            for (const key of c.absent ?? []) {
                expect(first.data).not.toHaveProperty(key);
            }
            for (const text of c.forbidden ?? []) {
                expect(JSON.stringify(first.data)).not.toContain(text);
            }
            if (base === null) {
                expect(token(first.revision).revision).toBe(1);
            } else {
                expect(token(first.revision)).toEqual({ ...token(base), revision: token(base).revision + 1 });
            }

            // The read-back on every read route, the projection included.
            expect(await (await s.get(c.kind, id)).json()).toEqual(first);
            const record = { id, revision: first.revision, data: first.data };
            expect(((await (await s.list(c.kind)).json()) as Listed).items).toEqual([record]);
            const kinds = (await (await s.readKinds(c.kind)).json()) as { kinds: Record<string, unknown[]> };
            expect(kinds.kinds[c.kind]).toEqual([record]);
            const refs = (await (await s.readRefs([{ kind: c.kind, id }])).json()) as { items: unknown[] };
            expect(refs.items).toEqual([{ kind: c.kind, ...record }]);

            // A stale write (the revision before the write, or a second create) is a 409 naming
            // the current revision, and changes nothing.
            const stale = await s.put(c.kind, id, { baseRevision: base, data: c.update });
            expect(stale.status).toBe(409);
            expect(await stale.json()).toEqual({ error: "Revision conflict", revision: first.revision });
            expect(await (await s.get(c.kind, id)).json()).toEqual(first);

            // The batch route persists a write on the current revision and advances it by one.
            const batch = await s.batch([{ kind: c.kind, id, baseRevision: first.revision, data: c.update }]);
            expect(batch.status, await batch.clone().text()).toBe(200);
            const applied = (await batch.json()) as Applied;
            expect(applied).toEqual({
                epoch: s.epoch,
                results: [{ kind: c.kind, id, revision: expect.any(String) }],
                chats: [],
                chatOrders: [],
            });
            const second = applied.results[0].revision!;
            expect(token(second)).toEqual({ ...token(first.revision), revision: token(first.revision).revision + 1 });
            const after = (await (await s.get(c.kind, id)).json()) as Stored;
            expect(after).toEqual({ epoch: s.epoch, revision: second, data: c.updated });
            for (const key of c.absent ?? []) {
                expect(after.data).not.toHaveProperty(key);
            }
            c.checkUpdated?.(after.data);

            // A stale batch op lists its conflict with the current revision and applies nothing.
            const staleBatch = await s.batch([{ kind: c.kind, id, baseRevision: first.revision, data: c.write }]);
            expect(staleBatch.status).toBe(409);
            expect(await staleBatch.json()).toEqual({
                error: "Revision conflict",
                conflicts: [{ kind: c.kind, id, revision: second }],
            });
            expect(await (await s.get(c.kind, id)).json()).toEqual(after);

            // A value the normalizer refuses is a 400 on both write routes, and changes nothing.
            const refused = await s.put(c.kind, id, { baseRevision: second, data: c.invalid });
            expect(refused.status).toBe(400);
            expect(((await refused.json()) as { error: string }).error).toMatch(c.refused);
            const refusedBatch = await s.batch([{ kind: c.kind, id, baseRevision: second, data: c.invalid }]);
            expect(refusedBatch.status).toBe(400);
            expect(((await refusedBatch.json()) as { error: string }).error).toMatch(c.refused);
            expect(await (await s.get(c.kind, id)).json()).toEqual(after);

            if (kind!.singleton) {
                // A singleton has only `main` and is never deleted.
                const other = await s.put(c.kind, "other", { baseRevision: null, data: c.write });
                expect(other.status).toBe(400);
                expect(await other.json()).toEqual({ error: `${c.kind} has only the record main` });
                const deleted = await s.remove(c.kind, id, `?baseRevision=${encodeURIComponent(second)}`);
                expect(deleted.status).toBe(400);
                expect(await deleted.json()).toEqual({ error: `${c.kind} cannot be deleted` });
                expect(await (await s.get(c.kind, id)).json()).toEqual(after);
            } else {
                // A per-record kind is deleted on its current revision.
                const deleted = await s.remove(c.kind, id, `?baseRevision=${encodeURIComponent(second)}`);
                expect(deleted.status).toBe(200);
                expect(await deleted.json()).toEqual({ success: true, epoch: s.epoch });
                expect((await s.get(c.kind, id)).status).toBe(404);
                expect(((await (await s.list(c.kind)).json()) as Listed).items).toEqual([]);
            }
        });
    }

    it("llmSecrets: a credential set through its route is masked on every read, kept by a plain write and a batch op, and a write carrying one is refused without an echo", async () => {
        const s = await server();
        const value = "sk-0123456789abcdef";
        const fresh = (await (await s.get("llmSecrets", "main")).json()) as Stored;
        const set = await s.json(
            "/api/llm-secrets/openAIKey",
            { value, baseRevision: fresh.revision },
            { method: "PUT" },
        );
        expect(set.status, await set.clone().text()).toBe(200);
        const keyed = (await set.json()) as Stored;
        expect(keyed.data).toEqual(expect.objectContaining({ openAIKey: masked(true, "cdef") }));
        expect(JSON.stringify(keyed)).not.toContain(value);
        expect(token(keyed.revision)).toEqual({
            ...token(fresh.revision),
            revision: token(fresh.revision).revision + 1,
        });

        // A plain write on the new revision keeps the stored credential; every read is masked.
        const put = await s.put("llmSecrets", "main", {
            baseRevision: keyed.revision,
            data: { google: { projectId: "proj" } },
        });
        expect(put.status, await put.clone().text()).toBe(200);
        const after = (await put.json()) as Stored;
        expect(after.data).toEqual(
            expect.objectContaining({
                openAIKey: masked(true, "cdef"),
                google: { accessToken: masked(false), projectId: "proj" },
            }),
        );
        const reads = [
            await s.get("llmSecrets", "main"),
            await s.list("llmSecrets"),
            await s.readKinds("llmSecrets"),
            await s.readRefs([{ kind: "llmSecrets", id: "main" }]),
        ];
        for (const read of reads) {
            const text = await read.text();
            expect(read.status, read.url).toBe(200);
            expect(text, read.url).not.toContain(value);
            expect(text, read.url).toContain('"openAIKey":{"set":true,"hint":"cdef"}');
        }

        // A batch op keeps it too.
        const batch = await s.batch([
            { kind: "llmSecrets", id: "main", baseRevision: after.revision, data: { google: { projectId: "proj2" } } },
        ]);
        expect(batch.status, await batch.clone().text()).toBe(200);
        const batched = (await (await s.get("llmSecrets", "main")).json()) as Stored;
        expect(batched.data).toEqual(
            expect.objectContaining({
                openAIKey: masked(true, "cdef"),
                google: { accessToken: masked(false), projectId: "proj2" },
            }),
        );

        // A write carrying a credential path, in any shape, is refused on both routes with no echo
        // and no change.
        const refused = await s.put("llmSecrets", "main", {
            baseRevision: batched.revision,
            data: { openAIKey: "sk-leak-put" },
        });
        expect(refused.status).toBe(400);
        const refusedText = await refused.text();
        expect(refusedText).toMatch(/written through \/api\/llm-secrets/);
        expect(refusedText).not.toContain("sk-leak-put");
        const refusedBatch = await s.batch([
            {
                kind: "llmSecrets",
                id: "main",
                baseRevision: batched.revision,
                data: { credentials: { c1: { key: "pk-leak-batch" } } },
            },
        ]);
        expect(refusedBatch.status).toBe(400);
        const refusedBatchText = await refusedBatch.text();
        expect(refusedBatchText).toMatch(/written through \/api\/llm-secrets/);
        expect(refusedBatchText).not.toContain("pk-leak-batch");
        expect(await (await s.get("llmSecrets", "main")).json()).toEqual(batched);
    });

    it("chats and chat orders: created in a batch with their character, normalized, read back, revision advanced, stale groups and reorders 409, bad chats 400", async () => {
        const s = await server();
        const batch = (body: unknown) => s.json("/api/resources/batch", body);

        // A character with its first chat in one batch: the chat's message without an id gets one,
        // and the character's chat order is created with it.
        const created = await batch({
            ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c" } }],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                name: "K",
                                message: [
                                    { role: "user", data: "A", chatId: "a" },
                                    { role: "char", data: "B" },
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        expect(created.status, await created.clone().text()).toBe(200);
        const body = (await created.json()) as {
            epoch: string;
            results: unknown[];
            chats: { characterId: string; id: string; revision: string; messageIds: string[] }[];
            chatOrders: { characterId: string; revision: string; ids: string[] }[];
        };
        expect(body).toEqual({
            epoch: s.epoch,
            results: [{ kind: "characters", id: "c", revision: expect.any(String) }],
            chats: [
                {
                    characterId: "c",
                    id: "k",
                    revision: expect.any(String),
                    messageIds: ["a", expect.stringMatching(/^[0-9a-f-]{36}$/)],
                },
            ],
            chatOrders: [{ characterId: "c", revision: expect.any(String), ids: ["k"] }],
        });
        const chatRevision = body.chats[0].revision;
        const orderRevision = body.chatOrders[0].revision;
        expect(token(chatRevision).revision).toBe(1);
        // The character's create made its order (revision 1); the chat's create wrote it (2).
        expect(token(orderRevision).revision).toBe(2);

        // The read-back: the normalized metadata (`name`, `note`, `localLore`, `fmIndex`) and the
        // messages in order, through the ref read, the collection read, and the kinds read.
        const chatData = expect.objectContaining({
            id: "k",
            name: "K",
            note: "",
            localLore: [],
            fmIndex: -1,
            message: [
                expect.objectContaining({ role: "user", data: "A", chatId: "a" }),
                expect.objectContaining({ role: "char", data: "B", chatId: body.chats[0].messageIds[1] }),
            ],
        });
        const read = (await (
            await s.json("/api/resources/read", { chats: [{ characterId: "c", id: "k" }], chatCollections: ["c"] })
        ).json()) as { chats: unknown[]; chatCollections: unknown[] };
        expect(read.chats).toEqual([{ characterId: "c", id: "k", revision: chatRevision, data: chatData }]);
        expect(read.chatCollections).toEqual([
            {
                characterId: "c",
                order: { characterId: "c", revision: orderRevision, ids: ["k"] },
                chats: [{ characterId: "c", id: "k", revision: chatRevision, data: chatData }],
            },
        ]);
        const kinds = (await (await s.request("/api/resources?kinds=characters&chats=1")).json()) as {
            chats: unknown[];
            chatOrders: unknown[];
        };
        expect(kinds.chats).toEqual([{ characterId: "c", id: "k", revision: chatRevision, data: chatData }]);
        expect(kinds.chatOrders).toEqual([{ characterId: "c", revision: orderRevision, ids: ["k"] }]);

        // An append on the held revision advances it by one and is read back.
        const appended = await batch({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: chatRevision,
                    ops: [
                        { op: "append", messages: [{ role: "char", data: "C", chatId: "c3" }], anchor: { end: true } },
                    ],
                },
            ],
        });
        expect(appended.status, await appended.clone().text()).toBe(200);
        const second = ((await appended.json()) as { chats: { revision: string }[] }).chats[0].revision;
        expect(token(second)).toEqual({ ...token(chatRevision), revision: token(chatRevision).revision + 1 });
        const reread = (await (
            await s.json("/api/resources/read", { chats: [{ characterId: "c", id: "k" }] })
        ).json()) as {
            chats: { revision: string; data: { message: { data: string }[] } }[];
        };
        expect(reread.chats[0].revision).toBe(second);
        expect(reread.chats[0].data.message.map((m) => m.data)).toEqual(["A", "B", "C"]);

        // A by-id op on an older revision is applied and flagged `stale` (the client has not seen
        // every change up to the answered revision), which advances the revision again.
        const staleMeta = await batch({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: chatRevision,
                    ops: [{ op: "meta", set: { note: "n" } }],
                },
            ],
        });
        expect(staleMeta.status, await staleMeta.clone().text()).toBe(200);
        expect(await staleMeta.json()).toEqual({
            epoch: s.epoch,
            results: [],
            chats: [{ characterId: "c", id: "k", revision: expect.any(String), stale: true }],
            chatOrders: [],
        });
        const afterMeta = (await (
            await s.json("/api/resources/read", { chats: [{ characterId: "c", id: "k" }] })
        ).json()) as {
            chats: { revision: string; data: { note: string; message: { data: string }[] } }[];
        };
        const third = afterMeta.chats[0].revision;
        expect(token(third)).toEqual({ ...token(second), revision: token(second).revision + 1 });
        expect(afterMeta.chats[0].data.note).toBe("n");
        expect(afterMeta.chats[0].data.message.map((m) => m.data)).toEqual(["A", "B", "C"]);

        // A revision-bound op (a `replace`) on an older revision is a 409 naming the chat's
        // current revision, and applies nothing.
        const stale = await batch({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: chatRevision,
                    ops: [{ op: "replace", chat: { name: "K", message: [] } }],
                },
            ],
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({
            error: "Revision conflict",
            conflicts: [{ kind: "chat", characterId: "c", id: "k", revision: third }],
        });
        const unchanged = (await (
            await s.json("/api/resources/read", { chats: [{ characterId: "c", id: "k" }] })
        ).json()) as { chats: unknown[] };
        expect(unchanged.chats).toEqual(afterMeta.chats);

        // A second chat joins the order (its revision advanced); a reorder on the held order
        // revision is applied; a stale reorder is a 409 naming the order's current revision.
        const k2 = await batch({
            chats: [
                {
                    characterId: "c",
                    chatId: "k2",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { name: "K2", message: [] } }],
                },
            ],
        });
        expect(k2.status, await k2.clone().text()).toBe(200);
        const order2 = ((await k2.json()) as { chatOrders: { characterId: string; revision: string; ids: string[] }[] })
            .chatOrders[0];
        expect(order2).toEqual({ characterId: "c", revision: expect.any(String), ids: ["k", "k2"] });
        expect(token(order2.revision)).toEqual({
            ...token(orderRevision),
            revision: token(orderRevision).revision + 1,
        });
        const reordered = await batch({
            chatOrders: [{ characterId: "c", baseRevision: order2.revision, ids: ["k2", "k"] }],
        });
        expect(reordered.status, await reordered.clone().text()).toBe(200);
        const order3 = ((await reordered.json()) as { chatOrders: { revision: string; ids: string[] }[] })
            .chatOrders[0];
        expect(order3).toEqual({ characterId: "c", revision: expect.any(String), ids: ["k2", "k"] });
        expect(token(order3.revision)).toEqual({
            ...token(order2.revision),
            revision: token(order2.revision).revision + 1,
        });
        const staleOrder = await batch({
            chatOrders: [{ characterId: "c", baseRevision: order2.revision, ids: ["k", "k2"] }],
        });
        expect(staleOrder.status).toBe(409);
        expect(await staleOrder.json()).toEqual({
            error: "Revision conflict",
            conflicts: [{ kind: "chatOrder", characterId: "c", revision: order3.revision }],
        });
        const all = (await (await s.request("/api/resources?kinds=characters&chats=1")).json()) as {
            chats: { id: string }[];
            chatOrders: unknown[];
        };
        expect(all.chatOrders).toEqual([{ characterId: "c", revision: order3.revision, ids: ["k2", "k"] }]);
        expect(all.chats.map((chat) => chat.id).sort()).toEqual(["k", "k2"]);

        // A chat the normalizer refuses is a 400, and nothing of the batch applies.
        const refused = await batch({
            chats: [
                {
                    characterId: "c",
                    chatId: "k3",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { name: 5, message: [] } }],
                },
            ],
        });
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toMatch(
            /chat\.name and chat\.note must be strings/,
        );
        expect(
            (
                (await (await s.request("/api/resources?kinds=characters&chats=1")).json()) as {
                    chats: { id: string }[];
                }
            ).chats
                .map((chat) => chat.id)
                .sort(),
        ).toEqual(["k", "k2"]);
    });
});
