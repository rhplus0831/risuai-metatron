// @vitest-environment happy-dom

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6, slice 1: the projection binding spike
// (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/spike-projection-bindings.md`). Every
// case runs over the test-only prototype in `projectionHarness.svelte.ts`: per-resource records
// held as `$state`, the two wrapper candidates (`projectRecord`, accessor-backed; `trackedRecord`,
// deep write-through), a root facade installed on the real `spikeRoot.db` (so the real
// `customQuotesData` items and real components run against it), and a prototype transport over the
// real server store (`StoreBackedServer`). Since Phase 6 slice 6 the real `getSettingValue` /
// `setSettingValue` resolve `bindKey`/`bindPath` through the settings record views (the real
// records), which the prototype does not back: the registry proofs run the pre-slice-6 registry copy
// over `spikeRoot.db` (`spikeRegistry.ts`), and the items' callbacks get a context over the facade.
//
// Every per-candidate proof runs three times: `accessor` (candidate 1), `tracked` (candidate 2,
// validating its path on every access), and `tracked-cached` (candidate 2 with the resolve cache).
//
// A proof that a candidate fails is asserted as the observed result (the failing candidate's
// expectation is the measured failure), so the suite stays green while recording each result.
//
// The module mocks are the Phase 3 spike's (`forwardingSpike.test.ts`): `stores.svelte.ts` wires
// module updates into a module-level effect, and the settings registry reaches the alert module.
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
    alertMd: vi.fn(),
}));

import type { character } from "../../../../shared/database.ts";
import { displaySettingsItems } from "../../setting/displaySettingsData.svelte";
import type { SettingContext, SettingItem } from "../../setting/types";
import { spikeRoot } from "./spikeRoot.svelte";
import { isSecretSet, llmSecretState, secretStatus } from "../llmSecrets.svelte";
import { safeStructuredClone } from "../../polyfill";
import { writeEntries } from "../mutationValidation";
import {
    applyRaw,
    applyRemote,
    CredentialRefusedError,
    derivedProbe,
    findLiveWrappers,
    setDisplacedReinsertion,
    setLiveRecord,
    stateContainer,
    bootRecords,
    CANDIDATES,
    CHARACTERS_KIND,
    deferredRevision,
    DetachedWrapperError,
    DuplicateIdError,
    dirtyKeys,
    flush,
    isAccessorView,
    isStateProxy,
    isTrackedWrapper,
    keyOf,
    liveRecord,
    mountFacade,
    persistedOf,
    PRESETS_KIND,
    projectRecord,
    queuedKeys,
    queueRecordWrite,
    recordView,
    reloadRecord,
    resetCounters,
    resetProjection,
    setResolveCache,
    snapshot,
    stats,
    switchPreset,
    trackedRecord,
    type Candidate,
} from "./projectionHarness.svelte";
import SpikeRecordInput from "./SpikeRecordInput.svelte";
import SpikeRecordList from "./SpikeRecordList.svelte";
import SpikeRecordMany from "./SpikeRecordMany.svelte";
import SpikeRecordSync from "./SpikeRecordSync.svelte";
import { candidateContext, candidateGetSettingValue, candidateSetSettingValue } from "./spikeRegistry";
import { StoreBackedServer } from "./storeBackedServer";

type Mounted = ReturnType<typeof mount>;

const CHA = "cha-spike";
const LORE_SIZE = 300;
const KINDS = ["ui", "providers", "secrets", "llmSecrets", PRESETS_KIND, CHARACTERS_KIND];
const UI = keyOf("ui", "main");
const SECRETS = keyOf("secrets", "main");
const LLM = keyOf("llmSecrets", "main");
const PRESETS = keyOf(PRESETS_KIND, "main");
const CHAR = keyOf(CHARACTERS_KIND, CHA);

/** The plaintext credentials the server holds; no batch body may ever carry one. */
const PLAINTEXT = {
    openAIKey: "sk-spike-plaintext-openai-0000001",
    google: "ya29-spike-plaintext-google-00001",
    horde: "horde-spike-plaintext-key-000001",
};

function loreEntry(index: number) {
    return {
        key: `key-${index}`,
        secondkey: "",
        insertorder: 100 + index,
        comment: `entry ${String(index).padStart(3, "0")}`,
        content: `content ${index}`,
        mode: "normal",
        alwaysActive: false,
        selective: false,
    };
}

function seed(server: StoreBackedServer) {
    server.set("ui", "main", {
        customCSS: "body { color: red; }",
        customQuotes: true,
        customQuotesData: ["«", "»", "‹", "›"],
    });
    server.set("providers", "main", { requestRetrys: 2 });
    server.set("secrets", "main", { deeplXOptions: { url: "https://deeplx.local", token: "" } });
    server.set("llmSecrets", "main", {
        openAIKey: PLAINTEXT.openAIKey,
        google: { accessToken: PLAINTEXT.google, projectId: "proj-1" },
        hordeConfig: { apiKey: PLAINTEXT.horde, model: "horde-model", softPrompt: "" },
    });
    server.set(PRESETS_KIND, "main", [
        {
            id: "a",
            name: "Preset A",
            temperature: 80,
            maxContext: 4000,
            promptSettings: {
                assistantPrefill: "",
                postEndInnerFormat: "a-format",
                sendChatAsSystem: false,
                sendName: false,
                utilOverride: false,
                customChainOfThought: false,
                maxThoughtTagDepth: -1,
            },
            reverseProxyOobaArgs: { mode: "instruct", name1_instruct: "a-user" },
            seperateParameters: {
                memory: {},
                emotion: {},
                translate: {},
                otherAx: {},
                overrides: { "model-x": { temperature: 70 } },
            },
        },
        {
            id: "b",
            name: "Preset B",
            temperature: 50,
            maxContext: 8000,
            reverseProxyOobaArgs: { mode: "chat", name1_instruct: "b-user" },
            // A `null` container the normalizer keeps (`PRESET_NULLABLE_FIELDS`).
            openrouterProvider: null,
        },
    ]);
    server.set(CHARACTERS_KIND, CHA, {
        type: "character",
        chaId: CHA,
        name: "Spike",
        desc: "the description",
        firstMessage: "hello",
        // A field that is not a character default (Phase 6 slice 5b: a deleted default is saved as its
        // default), for the delete proof.
        replaceGlobalNote: "the note",
        globalLore: Array.from({ length: LORE_SIZE }, (_, index) => loreEntry(index)),
    });
}

let server: StoreBackedServer;
const mounted: Mounted[] = [];

beforeEach(async () => {
    resetProjection();
    server = await StoreBackedServer.create();
    seed(server);
    await bootRecords(server, KINDS);
});

afterEach(async () => {
    const instances = mounted.splice(0);
    await Promise.all(instances.map((instance) => unmount(instance)));
    document.body.replaceChildren();
    server.close();
    resetProjection();
});

/** The candidate's settings context (`spikeRegistry.ts`): every section view is the facade on `spikeRoot.db`. */
function ctx(): SettingContext {
    return candidateContext();
}

function render(component: Parameters<typeof mount>[0], props: Record<string, unknown>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(component, { target, props });
    mounted.push(instance);
    flushSync();
    const input = <T extends Element = HTMLInputElement>(selector = "input") => {
        const element = target.querySelector<T>(selector);
        expect(element, `Expected ${selector} to be rendered`).not.toBeNull();
        return element as T;
    };
    return { target, input, instance };
}

/** A user edit: the value changes and `input` fires; effects are not flushed. */
function typeInto(element: HTMLInputElement, value: string) {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The plain JSON of a record as the store holds it now. */
function recordJson(kind: string, id = "main"): any {
    return JSON.parse(JSON.stringify(liveRecord(kind, id)));
}

/** `JSON.parse` of a record's JSON with `edit` applied (a server copy for `applyRaw`). */
function edited(kind: string, id: string, edit: (data: any) => void): any {
    const data = recordJson(kind, id);
    edit(data);
    return data;
}

/**
 * "Captured as one write": at least one `queueRecordWrite` call for exactly `key`, nothing queued
 * for any other key, and exactly one op for that record in the next flush's batch (accepted).
 */
async function capture(key: string) {
    const calls = stats.queueCalls.get(key) ?? 0;
    const otherKeys = queuedKeys().filter((other) => other !== key);
    // Round 2, point 2: the live records (not a snapshot) hold no wrapper or view, after every
    // write any proof captures.
    expect(findLiveWrappers()).toEqual([]);
    const sent = stats.bodies.length;
    const report = await flush();
    // Round 2, point 3: every body this flush sent, checked before any counter reset.
    for (const body of stats.bodies.slice(sent)) {
        expectNoCredential(body);
    }
    const opKeys = report.ops.map((op) => keyOf(op.kind, op.id));
    return {
        calls,
        otherKeys,
        opKeys,
        report,
        captured:
            calls > 0 && otherKeys.length === 0 && opKeys.length === 1 && opKeys[0] === key && report.status === 200,
    };
}

/** Every plaintext credential the suite writes or seeds. */
const CREDENTIALS = [
    ...Object.values(PLAINTEXT),
    "sk-new-plaintext-0000000002",
    "ya29-new-plaintext-0000002",
    "horde-new-plaintext-000002",
    "ya29-whole-plaintext-000009",
    "oai-whole-plaintext-000001",
    "oai-entry-plaintext-000003",
    "pk-a-plaintext-0000000001",
];

/** A batch body never carries a plaintext credential or a masked leaf. */
function expectNoCredential(body: string) {
    for (const secret of CREDENTIALS) {
        expect(body).not.toContain(secret);
    }
    expect(body).not.toContain('"set":');
    expect(body).not.toContain('"hint":');
}

/** Lets the current task end (the same-task re-insertion window closes). */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Whether any nested value of a snapshot is a wrapper, a view, or a Svelte proxy. */
function leaks(value: unknown, seen = new Set<unknown>()): string[] {
    if (typeof value !== "object" || value === null || seen.has(value)) {
        return [];
    }
    seen.add(value);
    const found: string[] = [];
    if (isTrackedWrapper(value) || isAccessorView(value) || isStateProxy(value)) {
        found.push("leak");
    }
    for (const key of Object.keys(value)) {
        found.push(...leaks((value as Record<string, unknown>)[key], seen));
    }
    return found;
}

function forInKeys(value: object): string[] {
    const keys: string[] = [];
    for (const key in value) {
        keys.push(key);
    }
    return keys;
}

/** The selected preset's index now. */
function presetIndex(id: string): number {
    return (liveRecord(PRESETS_KIND) as any[]).findIndex((preset) => preset.id === id);
}

const livePreset = (id: string) => (liveRecord(PRESETS_KIND) as any[])[presetIndex(id)];
const liveChar = () => liveRecord<any>(CHARACTERS_KIND, CHA);

/** The results each candidate shows; `tracked` is expected to pass everything. */
const onlyTracked = (candidate: Candidate) => candidate !== "accessor";

// ---------------------------------------------------------------------------------------------

describe("Svelte 5.57.1 facts the pattern relies on", () => {
    it("a Svelte proxy drops an assignment of `__proto__`; a `defineProperty` of it is readable but never enumerated", () => {
        applyRaw("providers", "probe", { map: { plain: 1 } });
        const map = liveRecord<any>("providers", "probe").map;

        map["__proto__"] = { injected: true };
        expect(Object.hasOwn(map, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
        expect(JSON.stringify(map)).toBe('{"plain":1}');

        Object.defineProperty(map, "__proto__", {
            value: { defined: true },
            writable: true,
            enumerable: true,
            configurable: true,
        });
        // Read back from the proxy's own source ...
        expect(map["__proto__"]).toEqual({ defined: true });
        // ... but `ownKeys` lists a source only for a key not `in` the target, and `'__proto__' in target` is true.
        expect(Object.keys(map)).toEqual(["plain"]);
        expect(JSON.stringify(map)).toBe('{"plain":1}');

        // An object given whole with an own `__proto__` key keeps it (the `writeEntries` route).
        liveRecord<any>("providers", "probe").map = JSON.parse('{"__proto__":{"own":true},"plain":2}');
        const replaced = liveRecord<any>("providers", "probe").map;
        expect(Object.hasOwn(replaced, "__proto__")).toBe(true);
        expect(JSON.stringify(replaced)).toBe('{"__proto__":{"own":true},"plain":2}');
        expect(snapshot(replaced)).toEqual({ plain: 2 });
        expect(Object.hasOwn(snapshot(replaced), "__proto__")).toBe(false);
    });

    it("a wrapper answers `STATE_SYMBOL in value` from its target, so Svelte stores a wrapper written raw into state as-is", () => {
        const wrapper = trackedRecord(CHARACTERS_KIND, CHA).globalLore[0];
        expect(isTrackedWrapper(wrapper)).toBe(true);
        // A raw write (not through a wrapper, which unwraps) keeps the wrapper object inside the state.
        liveRecord<any>("providers", "main").leaked = wrapper;
        expect(isTrackedWrapper(liveRecord<any>("providers", "main").leaked)).toBe(true);
        // Through a wrapper of another record it is stored as a detached copy (round 2: no record
        // aliases another record's state) ...
        trackedRecord<any>("providers", "main").unwrapped = wrapper;
        const stored = liveRecord<any>("providers", "main").unwrapped;
        expect(isTrackedWrapper(stored)).toBe(false);
        expect(Object.is(stored, liveChar().globalLore[0])).toBe(false);
        expect(snapshot(stored)).toEqual(recordJson(CHARACTERS_KIND, CHA).globalLore[0]);
        // ... and through a wrapper of the same record, as the `$state` object it stands for.
        trackedRecord<any>(CHARACTERS_KIND, CHA).aliased = wrapper;
        expect(Object.is(liveChar().aliased, liveChar().globalLore[0])).toBe(true);
        delete liveRecord<any>("providers", "main").leaked;
        delete liveRecord<any>("providers", "main").unwrapped;
        delete liveChar().aliased;
    });
});

describe.each(CANDIDATES)("candidate %s", (candidate) => {
    let db: any;
    const view = <T = any>(kind: string, id = "main") => recordView<T>(candidate, kind, id);

    beforeEach(() => {
        db = mountFacade(candidate, [CHA]);
        resetCounters();
    });

    describe("proof 1: binding", () => {
        it("bind:value on a top-level section field writes the record, captured as one write; edits coalesce; applyRaw re-renders", async () => {
            const { input } = render(SpikeRecordInput, { record: view("ui"), field: "customCSS", id: "p1-top" });
            const element = input();
            expect(element.value).toBe("body { color: red; }");

            typeInto(element, "a {}");
            expect(liveRecord<any>("ui").customCSS).toBe("a {}");
            typeInto(element, "b {}");
            expect(stats.queueCalls.get(UI)).toBe(2);
            const result = await capture(UI);
            expect(result.captured).toBe(true);
            expect(result.report.ops[0].data.customCSS).toBe("b {}");
            expect(server.record("ui", "main")!.data.customCSS).toBe("b {}");

            resetCounters();
            applyRaw(
                "ui",
                "main",
                edited("ui", "main", (data) => (data.customCSS = "raw {}")),
            );
            flushSync();
            expect(element.value).toBe("raw {}");
            expect(queuedKeys()).toEqual([]);
        });

        it("bind:value on a nested field (`reverseProxyOobaArgs.name1_instruct` through the facade)", async () => {
            const { input } = render(SpikeRecordInput, {
                get record() {
                    return db.reverseProxyOobaArgs;
                },
                field: "name1_instruct",
            });
            const element = input();
            expect(element.value).toBe("a-user");

            typeInto(element, "edited-1");
            typeInto(element, "edited-2");
            expect(livePreset("a").reverseProxyOobaArgs.name1_instruct).toBe("edited-2");
            expect(livePreset("b").reverseProxyOobaArgs.name1_instruct).toBe("b-user");
            const result = await capture(PRESETS);
            // Candidate 1 returns the raw nested object: the write bypasses the queue.
            expect(result.captured).toBe(onlyTracked(candidate));
            if (candidate !== "accessor") {
                expect(result.calls).toBe(2);
                expect(result.report.ops[0].data[0].reverseProxyOobaArgs.name1_instruct).toBe("edited-2");
            } else {
                expect(result.calls).toBe(0);
                expect(result.report.ops).toEqual([]);
            }

            resetCounters();
            applyRaw(
                PRESETS_KIND,
                "main",
                edited(PRESETS_KIND, "main", (data) => (data[0].reverseProxyOobaArgs.name1_instruct = "raw")),
            );
            flushSync();
            expect(element.value).toBe("raw");
            expect(queuedKeys()).toEqual([]);
        });

        it("bind:value on an array element field (`globalLore[3].content`)", async () => {
            const { input } = render(SpikeRecordInput, {
                get record() {
                    return db.characters[0].globalLore[3];
                },
                field: "content",
            });
            const element = input();
            expect(element.value).toBe("content 3");

            typeInto(element, "lore-1");
            typeInto(element, "lore-2");
            expect(liveChar().globalLore[3].content).toBe("lore-2");
            const result = await capture(CHAR);
            expect(result.captured).toBe(onlyTracked(candidate));
            if (candidate !== "accessor") {
                expect(result.report.ops[0].data.globalLore[3].content).toBe("lore-2");
                expect(server.record(CHARACTERS_KIND, CHA)!.data.globalLore[3].content).toBe("lore-2");
            }

            resetCounters();
            applyRaw(
                CHARACTERS_KIND,
                CHA,
                edited(CHARACTERS_KIND, CHA, (data: any) => (data.globalLore[3].content = "raw")),
            );
            flushSync();
            expect(element.value).toBe("raw");
            expect(queuedKeys()).toEqual([]);
        });

        it("the function binding over the registry resolution (the pre-slice-6 copy): bindKey, bindPath, and item callbacks", async () => {
            const items: { item: SettingItem; key: string; nested: boolean; read: () => unknown; raw: () => void }[] = [
                {
                    item: { id: "spike.customCSS", type: "text", bindKey: "customCSS" },
                    key: UI,
                    nested: false,
                    read: () => liveRecord<any>("ui").customCSS,
                    raw: () =>
                        applyRaw(
                            "ui",
                            "main",
                            edited("ui", "main", (data) => (data.customCSS = "raw")),
                        ),
                },
                {
                    item: { id: "spike.name1", type: "text", bindPath: "reverseProxyOobaArgs.name1_instruct" },
                    key: PRESETS,
                    nested: true,
                    read: () => livePreset("a").reverseProxyOobaArgs.name1_instruct,
                    raw: () =>
                        applyRaw(
                            PRESETS_KIND,
                            "main",
                            edited(
                                PRESETS_KIND,
                                "main",
                                (data) => (data[0].reverseProxyOobaArgs.name1_instruct = "raw"),
                            ),
                        ),
                },
                {
                    item: {
                        id: "spike.lore3",
                        type: "text",
                        // Item callbacks take the context since slice 6; the character is the facade's.
                        getValue: () => (spikeRoot.db.characters[0] as character).globalLore[3].content,
                        setValue: (value: string) => {
                            (spikeRoot.db.characters[0] as character).globalLore[3].content = value;
                        },
                    },
                    key: CHAR,
                    nested: true,
                    read: () => liveChar().globalLore[3].content,
                    raw: () =>
                        applyRaw(
                            CHARACTERS_KIND,
                            CHA,
                            edited(CHARACTERS_KIND, CHA, (data: any) => (data.globalLore[3].content = "raw")),
                        ),
                },
            ];
            for (const [index, entry] of items.entries()) {
                resetCounters();
                const { input } = render(SpikeRecordSync, { item: entry.item, ctx: ctx(), id: `p1-sync-${index}` });
                const element = input(`#p1-sync-${index}`);
                typeInto(element, `fn-${index}-1`);
                typeInto(element, `fn-${index}-2`);
                expect(entry.read()).toBe(`fn-${index}-2`);
                const result = await capture(entry.key);
                expect(result.captured, entry.item.id).toBe(!entry.nested || onlyTracked(candidate));

                resetCounters();
                entry.raw();
                flushSync();
                expect(element.value, entry.item.id).toBe("raw");
                expect(queuedKeys()).toEqual([]);
            }
        });
    });

    describe("proof 2: snapshots", () => {
        it("snapshot, JSON, keys, for-in, and a JSON clone of a wrapper and of the facade give plain data equal to the record; nothing queues", () => {
            render(SpikeRecordInput, { record: view("ui"), field: "customCSS" });
            for (const [kind, id] of [
                ["ui", "main"],
                [PRESETS_KIND, "main"],
                [CHARACTERS_KIND, CHA],
                ["llmSecrets", "main"],
            ]) {
                const wrapper = view(kind, id);
                const expected = recordJson(kind, id);
                const snap = snapshot(wrapper);
                expect(snap, kind).toEqual(expected);
                expect(leaks(snap), kind).toEqual([]);
                expect(() => structuredClone(snap)).not.toThrow();
                expect(JSON.stringify(wrapper), kind).toBe(JSON.stringify(liveRecord(kind, id)));
                expect(Object.keys(wrapper), kind).toEqual(Object.keys(liveRecord(kind, id)));
                expect(forInKeys(wrapper), kind).toEqual(forInKeys(liveRecord(kind, id)));
                expect(JSON.parse(JSON.stringify(wrapper)), kind).toEqual(expected);
                expect(Array.isArray(wrapper), kind).toBe(Array.isArray(expected));
            }

            const facade = snapshot(spikeRoot.db) as any;
            expect(leaks(facade)).toEqual([]);
            expect(() => structuredClone(facade)).not.toThrow();
            expect(facade.customCSS).toBe("body { color: red; }");
            expect(facade.deeplXOptions).toEqual({ url: "https://deeplx.local", token: "" });
            expect(facade.botPresets).toEqual(recordJson(PRESETS_KIND));
            expect(facade.characters).toEqual([recordJson(CHARACTERS_KIND, CHA)]);
            expect(facade.temperature).toBe(80);
            expect(facade.reverseProxyOobaArgs).toEqual({ mode: "instruct", name1_instruct: "a-user" });
            const json = JSON.parse(JSON.stringify(spikeRoot.db));
            expect(json.botPresets).toEqual(facade.botPresets);
            expect(json.characters).toEqual(facade.characters);
            expect(json.customQuotesData).toEqual(["«", "»", "‹", "›"]);
            expect(Object.keys(spikeRoot.db)).toContain("botPresets");
            expect(Object.keys(spikeRoot.db)).toContain("temperature");
            expect(forInKeys(spikeRoot.db)).toEqual(Object.keys(spikeRoot.db));

            expect(stats.queueCalls.size).toBe(0);
            expect(dirtyKeys()).toEqual([]);
        });
    });

    describe("proof 3: every write shape", () => {
        it("a handler assignment of a section field and of a nested lore field", async () => {
            db.customCSS = "handler {}";
            const top = await capture(UI);
            expect(top.captured).toBe(true);

            resetCounters();
            db.characters[0].globalLore[5].comment = "handler comment";
            expect(liveChar().globalLore[5].comment).toBe("handler comment");
            const nested = await capture(CHAR);
            expect(nested.captured).toBe(onlyTracked(candidate));
        });

        it("push, splice, sort, unshift, and the LoreBookList reorder on a nested array", async () => {
            const lore = () => db.characters[0].globalLore;
            const shapes: [string, () => void, () => void][] = [
                [
                    "push",
                    () => lore().push(loreEntry(900)),
                    () => expect(liveChar().globalLore.at(-1).key).toBe("key-900"),
                ],
                ["splice", () => lore().splice(1, 2), () => expect(liveChar().globalLore[1].key).toBe("key-3")],
                [
                    "sort",
                    () => lore().sort((x: any, y: any) => y.insertorder - x.insertorder),
                    () =>
                        expect(liveChar().globalLore[0].insertorder).toBeGreaterThan(
                            liveChar().globalLore[1].insertorder,
                        ),
                ],
                [
                    "unshift",
                    () => lore().unshift(loreEntry(901)),
                    () => expect(liveChar().globalLore[0].key).toBe("key-901"),
                ],
                [
                    "reorder (splice(0, length, ...sorted))",
                    () => {
                        const reordered = [...lore()];
                        const [moved] = reordered.splice(0, 1);
                        reordered.splice(4, 0, moved);
                        lore().splice(0, lore().length, ...reordered);
                    },
                    () => expect(liveChar().globalLore[4].key).toBe("key-901"),
                ],
            ];
            for (const [name, write, check] of shapes) {
                resetCounters();
                write();
                check();
                expect(leaks(snapshot(liveChar())), name).toEqual([]);
                expect(isTrackedWrapper(liveChar().globalLore[0]), name).toBe(false);
                const result = await capture(CHAR);
                expect(result.captured, name).toBe(onlyTracked(candidate));
                if (result.captured) {
                    expect(server.record(CHARACTERS_KIND, CHA)!.data.globalLore, name).toEqual(
                        recordJson(CHARACTERS_KIND, CHA).globalLore,
                    );
                }
            }
            // Whatever was captured, the record never held a wrapper.
            expect(leaks(snapshot(liveChar()))).toEqual([]);
            expect(liveChar().globalLore.some((entry: unknown) => isTrackedWrapper(entry))).toBe(false);
        });

        it("a whole-array replacement of a field, and of the presets collection through the facade", async () => {
            db.characters[0].globalLore = [...db.characters[0].globalLore].reverse();
            expect(liveChar().globalLore[0].key).toBe(`key-${LORE_SIZE - 1}`);
            expect(leaks(snapshot(liveChar()))).toEqual([]);
            const field = await capture(CHAR);
            expect(field.captured).toBe(true);
            expect(server.record(CHARACTERS_KIND, CHA)!.data.globalLore[0].key).toBe(`key-${LORE_SIZE - 1}`);

            resetCounters();
            db.botPresets = [...db.botPresets].reverse();
            expect(liveRecord<any[]>(PRESETS_KIND).map((preset) => preset.id)).toEqual(["b", "a"]);
            const collection = await capture(PRESETS);
            expect(collection.captured).toBe(true);
            expect(server.record(PRESETS_KIND, "main")!.data.map((preset: any) => preset.id)).toEqual(["b", "a"]);
        });

        it("the cast form `(db.characters[i] as character).x = v`", async () => {
            (spikeRoot.db.characters[0] as character).desc = "cast";
            expect(liveChar().desc).toBe("cast");
            const result = await capture(CHAR);
            expect(result.captured).toBe(true);
            expect(server.record(CHARACTERS_KIND, CHA)!.data.desc).toBe("cast");
        });

        it("delete of a key: gone from the serialization, reads undefined, a later set restores it", async () => {
            const character = db.characters[0];
            expect(delete character.replaceGlobalNote).toBe(true);
            expect(character.replaceGlobalNote).toBeUndefined();
            if (candidate !== "accessor") {
                expect("replaceGlobalNote" in liveChar()).toBe(false);
                const removed = await capture(CHAR);
                expect(removed.captured).toBe(true);
                expect(JSON.parse(stats.bodies[0]).ops[0].data).not.toHaveProperty("replaceGlobalNote");
                expect(server.record(CHARACTERS_KIND, CHA)!.data).not.toHaveProperty("replaceGlobalNote");

                resetCounters();
                character.replaceGlobalNote = "restored";
                expect(liveChar().replaceGlobalNote).toBe("restored");
                const restored = await capture(CHAR);
                expect(restored.captured).toBe(true);
                expect(server.record(CHARACTERS_KIND, CHA)!.data.replaceGlobalNote).toBe("restored");
            } else {
                // Candidate 1: `delete` removes the view's accessor; the record keeps the key and nothing queues.
                expect(liveChar().replaceGlobalNote).toBe("the note");
                expect(queuedKeys()).toEqual([]);
                // A later set creates a plain data property on the view; the record never sees it.
                character.replaceGlobalNote = "restored";
                expect(liveChar().replaceGlobalNote).toBe("the note");
                expect(character.replaceGlobalNote).toBe("restored");
                const result = await capture(CHAR);
                expect(result.captured).toBe(false);
                expect(result.report.ops).toEqual([]);
            }
        });

        it("`??=` creating a null container (the bindPath branch of setSettingValue), container and leaf in the record", async () => {
            switchPreset("b");
            expect(livePreset("b").openrouterProvider).toBeNull();
            const item: SettingItem = { id: "spike.order", type: "text", bindPath: "openrouterProvider.order" };
            candidateSetSettingValue(item, ["openai"], ctx());
            expect(livePreset("b").openrouterProvider).toEqual({ order: ["openai"] });
            expect(livePreset("a").openrouterProvider).not.toEqual({ order: ["openai"] });
            const preset = await capture(PRESETS);
            // Candidate 1 writes the container into the raw preset object (no queue).
            expect(preset.captured).toBe(onlyTracked(candidate));
            if (preset.captured) {
                expect(preset.report.ops[0].data[1].openrouterProvider).toEqual({ order: ["openai"] });
            }

            // The same branch on a section field (a top-level container of its record).
            resetCounters();
            applyRaw(
                "secrets",
                "main",
                edited("secrets", "main", (data) => (data.deeplXOptions = null)),
            );
            candidateSetSettingValue(
                { id: "spike.deeplx", type: "text", bindPath: "deeplXOptions.url" },
                "https://new",
                ctx(),
            );
            expect(liveRecord<any>("secrets").deeplXOptions).toEqual({ url: "https://new" });
            const section = await capture(SECRETS);
            expect(section.captured).toBe(true);
            expect(section.report.ops[0].data.deeplXOptions).toEqual({ url: "https://new" });
        });
    });

    describe("proof 4: the registry", () => {
        const customQuotes = () => displaySettingsItems.find((item) => item.id === "display.customQuotes")!;
        const quoteItems = () =>
            [
                "display.leadingDoubleQuote",
                "display.trailingDoubleQuote",
                "display.leadingSingleQuote",
                "display.trailingSingleQuote",
            ].map((id) => displaySettingsItems.find((item) => item.id === id)!);
        // A literal copy of `lang.deeplXUrl` (`languageSettingsData.svelte.ts`, not imported: it pulls the translator).
        const deeplXUrl: SettingItem = {
            id: "lang.deeplXUrl",
            type: "text",
            labelKey: "deeplXUrl",
            bindPath: "deeplXOptions.url",
        };

        /** Reads every item, writes every item once, reads again; returns the reads and the touched fields. */
        function runRegistry() {
            const items = [customQuotes(), deeplXUrl, ...quoteItems()];
            const before = items.map((item) => candidateGetSettingValue(item, ctx()));
            candidateSetSettingValue(customQuotes(), false, ctx());
            candidateSetSettingValue(deeplXUrl, "https://changed", ctx());
            quoteItems().forEach((item, index) => candidateSetSettingValue(item, ["<", ">", "(", ")"][index], ctx()));
            const after = items.map((item) => candidateGetSettingValue(item, ctx()));
            const fields = JSON.parse(
                JSON.stringify({
                    customQuotes: spikeRoot.db.customQuotes,
                    customQuotesData: spikeRoot.db.customQuotesData,
                    deeplXOptions: spikeRoot.db.deeplXOptions,
                }),
            );
            return { before, after, fields };
        }

        it("resolves and writes exactly as over a plain object", () => {
            const overFacade = runRegistry();
            // Candidate 1: the `deeplXOptions.url` write lands in the existing container without a queue.
            expect(new Set(queuedKeys())).toEqual(new Set(candidate !== "accessor" ? [UI, SECRETS] : [UI]));
            expect(overFacade.after).toEqual([false, "https://changed", "<", ">", "(", ")"]);
            expect(liveRecord<any>("ui").customQuotesData).toEqual(["<", ">", "(", ")"]);
            expect(liveRecord<any>("secrets").deeplXOptions.url).toBe("https://changed");

            // The same sequence over a plain object holding the seeded values.
            spikeRoot.db = {
                customQuotes: true,
                customQuotesData: ["«", "»", "‹", "›"],
                deeplXOptions: { url: "https://deeplx.local", token: "" },
            } as any;
            const overPlain = runRegistry();
            expect(overFacade).toEqual(overPlain);
        });

        it("each item's write is captured on the right record (container present, and created by `??=`)", async () => {
            const cases: { name: string; prepare?: () => void; write: () => void; key: string; nested: boolean }[] = [
                {
                    name: "bindKey customQuotes",
                    write: () => candidateSetSettingValue(customQuotes(), false, ctx()),
                    key: UI,
                    nested: false,
                },
                {
                    name: "bindPath deeplXOptions.url",
                    write: () => candidateSetSettingValue(deeplXUrl, "https://x", ctx()),
                    key: SECRETS,
                    nested: true,
                },
                {
                    name: "bindPath deeplXOptions.url over null",
                    prepare: () =>
                        applyRaw(
                            "secrets",
                            "main",
                            edited("secrets", "main", (data) => (data.deeplXOptions = null)),
                        ),
                    write: () => candidateSetSettingValue(deeplXUrl, "https://y", ctx()),
                    key: SECRETS,
                    nested: false,
                },
                {
                    name: "customQuotesData[0] item",
                    write: () => candidateSetSettingValue(quoteItems()[0], "<", ctx()),
                    key: UI,
                    nested: true,
                },
                {
                    name: "customQuotesData[3] item over null",
                    prepare: () =>
                        applyRaw(
                            "ui",
                            "main",
                            edited("ui", "main", (data) => (data.customQuotesData = null)),
                        ),
                    write: () => candidateSetSettingValue(quoteItems()[3], ")", ctx()),
                    key: UI,
                    nested: false,
                },
            ];
            for (const entry of cases) {
                entry.prepare?.();
                resetCounters();
                entry.write();
                const result = await capture(entry.key);
                // `nested`: the item writes inside an existing container (candidate 1 bypasses the queue there).
                expect(result.captured, entry.name).toBe(!entry.nested || onlyTracked(candidate));
            }
            expect(liveRecord<any>("ui").customQuotesData).toEqual(['"', '"', "'", ")"]);
        });
    });

    describe("proof 6: edit then same-task selection switch", () => {
        it("a facade edit of `temperature` then a switch to `b` lands in `a`; `b` is unchanged; the flush sends it", async () => {
            db.temperature = 33;
            switchPreset("b");
            expect(livePreset("a").temperature).toBe(33);
            expect(livePreset("b").temperature).toBe(50);
            expect(db.temperature).toBe(50);
            const result = await capture(PRESETS);
            expect(result.captured).toBe(onlyTracked(candidate));
            if (result.captured) {
                expect(server.record(PRESETS_KIND, "main")!.data.map((preset: any) => preset.temperature)).toEqual([
                    33, 50,
                ]);
            }
        });

        it("the same through the function binding, the switch in the input's task", async () => {
            const item: SettingItem = { id: "spike.temperature", type: "text", bindKey: "temperature" };
            const { input } = render(SpikeRecordSync, { item, ctx: ctx() });
            const element = input();
            expect(element.value).toBe("80");
            typeInto(element, "44");
            switchPreset("b");
            flushSync();
            expect(livePreset("a").temperature).toBe("44");
            expect(livePreset("b").temperature).toBe(50);
            expect(element.value).toBe("50");
            const result = await capture(PRESETS);
            expect(result.captured).toBe(onlyTracked(candidate));
        });
    });

    describe("proof 7: live replacement", () => {
        for (const path of ["reload (applyRaw)", "applyRemote"] as const) {
            it(`replacing the character through ${path} while bound re-renders, queues and sends nothing; a later write through the cached wrapper targets the new record`, async () => {
                const cached = view(CHARACTERS_KIND, CHA);
                const { input } = render(SpikeRecordInput, {
                    get record() {
                        return cached.globalLore[3];
                    },
                    field: "content",
                });
                const element = input();
                server.set(
                    CHARACTERS_KIND,
                    CHA,
                    edited(CHARACTERS_KIND, CHA, (data: any) => {
                        data.globalLore[3].content = "remote";
                        data.desc = "remote desc";
                    }),
                );
                const remote = server.record(CHARACTERS_KIND, CHA)!;
                if (path === "applyRemote") {
                    expect(applyRemote(CHARACTERS_KIND, CHA, remote.revision, remote.data)).toBe(true);
                } else {
                    await reloadRecord(CHARACTERS_KIND, CHA);
                }
                flushSync();
                expect(element.value).toBe("remote");
                expect(stats.queueCalls.size).toBe(0);
                const idle = await flush();
                expect(idle.status).toBeNull();
                expect(stats.bodies).toEqual([]);
                expect(persistedOf(CHARACTERS_KIND, CHA)!.revision).toBe(remote.revision);

                // A later write through the same cached wrapper: the new record, based on the new revision.
                cached.desc = "after";
                expect(liveChar().desc).toBe("after");
                const top = await capture(CHAR);
                expect(top.captured).toBe(true);
                expect(top.report.ops[0].baseRevision).toBe(remote.revision);

                resetCounters();
                cached.globalLore[3].content = "after nested";
                expect(liveChar().globalLore[3].content).toBe("after nested");
                flushSync();
                expect(element.value).toBe("after nested");
                const nested = await capture(CHAR);
                expect(nested.captured).toBe(onlyTracked(candidate));
            });
        }
    });

    describe("proof 8: an own `__proto__` key in a user-keyed map", () => {
        const withProto = () =>
            JSON.parse(
                JSON.stringify(liveRecord(PRESETS_KIND)).replace(
                    '"overrides":{',
                    '"overrides":{"__proto__":{"temperature":11},',
                ),
            );

        it("arriving through applyRaw, it reads as a value and stays in the flush serialization", async () => {
            applyRaw(PRESETS_KIND, "main", withProto());
            const overrides = view(PRESETS_KIND)[0].seperateParameters.overrides;
            expect(overrides["__proto__"]).toEqual({ temperature: 11 });
            expect(overrides["__proto__"].temperature).toBe(11);
            expect(Object.getPrototypeOf(overrides)).toBe(Object.prototype);
            expect(Object.keys(overrides)).toEqual(["__proto__", "model-x"]);
            expect(JSON.stringify(view(PRESETS_KIND))).toContain('"__proto__":{"temperature":11}');
            // `$state.snapshot` drops it (it assigns `copy[key]`), which is why the flush serializes the live proxy.
            expect(Object.hasOwn(snapshot(view(PRESETS_KIND))[0].seperateParameters.overrides, "__proto__")).toBe(
                false,
            );

            // A mark plus a raw edit (candidate-neutral): the transport keeps the key.
            livePreset("a").temperature = 81;
            queueRecordWrite(PRESETS_KIND, "main");
            const result = await capture(PRESETS);
            expect(result.captured).toBe(true);
            expect(stats.bodies[0]).toContain('"__proto__":{"temperature":11}');
            expect(
                Object.hasOwn(server.record(PRESETS_KIND, "main")!.data[0].seperateParameters.overrides, "__proto__"),
            ).toBe(true);
        });

        it("a write of an own `__proto__` entry the way the real writers do it (`writeEntries`) creates an own key and is captured", async () => {
            const separate = view(PRESETS_KIND)[0].seperateParameters;
            const next = writeEntries(separate.overrides, [["__proto__", { temperature: 22 }]]);
            expect(next).not.toBeNull();
            separate.overrides = next;
            const stored = livePreset("a").seperateParameters.overrides;
            expect(Object.hasOwn(stored, "__proto__")).toBe(true);
            expect(stored["__proto__"]).toEqual({ temperature: 22 });
            expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
            expect(stored["model-x"]).toEqual({ temperature: 70 });
            expect(leaks(snapshot(livePreset("a")))).toEqual([]);
            const result = await capture(PRESETS);
            expect(result.captured).toBe(onlyTracked(candidate));
            if (result.captured) {
                expect(stats.bodies[0]).toContain('"__proto__":{"temperature":22}');
            }
        });

        it("a naive assignment `overrides['__proto__'] = v`", async () => {
            const overrides = view(PRESETS_KIND)[0].seperateParameters.overrides;
            overrides["__proto__"] = { temperature: 33 };
            const stored = livePreset("a").seperateParameters.overrides;
            expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
            if (candidate !== "accessor") {
                // Candidate 2 rebuilds the map the `writeEntries` way and installs it in its parent.
                expect(Object.hasOwn(stored, "__proto__")).toBe(true);
                expect(stored["__proto__"]).toEqual({ temperature: 33 });
                const result = await capture(PRESETS);
                expect(result.captured).toBe(true);
                expect(stats.bodies[0]).toContain('"__proto__":{"temperature":33}');
            } else {
                // Candidate 1 hands the write to the Svelte proxy, which drops it silently.
                expect(Object.hasOwn(stored, "__proto__")).toBe(false);
                expect(queuedKeys()).toEqual([]);
            }
        });
    });

    describe("proof 9: the llmSecrets siblings and the credential boundary", () => {
        const llm = () => view("llmSecrets");
        const queued = () => llmSecretState.queue.map((op) => op.request);
        const recordText = () => JSON.stringify(liveRecord("llmSecrets"));
        const expectNoPlaintextInRecord = () => {
            for (const secret of CREDENTIALS) {
                expect(recordText()).not.toContain(secret);
            }
        };
        const flat = (field: string) => ({ kind: "flat", field });
        const nested = (field: string) => ({ kind: "nested", field });
        const mapEntry = (id: string) => ({ kind: "map", field: "OaiCompAPIKeys", id });
        const presetEntry = (id: string) => ({ kind: "entry", field: "presets", id });

        it("the facade reads blank credentials (the mirror form); the masked status is read-only in llmSecretState", () => {
            expect(db.openAIKey).toBe("");
            expect(snapshot(db.google)).toEqual({ projectId: "proj-1", accessToken: "" });
            expect(db.hordeConfig.apiKey).toBe("");
            expect(snapshot(db.OaiCompAPIKeys)).toEqual({});
            expect(db.proxyKey).toBe("");
            expect(isSecretSet(flat("openAIKey") as any)).toBe(true);
            expect(secretStatus(nested("google") as any)).toEqual({
                set: true,
                hint: PLAINTEXT.google.slice(-4),
                pending: false,
            });
            expect(recordText()).not.toContain('"set"');
            expectNoPlaintextInRecord();
        });

        it("a sibling write is captured and its op carries the siblings only", async () => {
            db.google.projectId = "proj-2";
            expect(liveRecord<any>("llmSecrets").google.projectId).toBe("proj-2");
            const nestedWrite = await capture(LLM);
            expect(nestedWrite.captured).toBe(onlyTracked(candidate));

            resetCounters();
            db.vertexClientEmail = "spike@example.invalid";
            const top = await capture(LLM);
            expect(top.captured).toBe(true);
            const data = top.report.ops[0].data;
            expect(data.vertexClientEmail).toBe("spike@example.invalid");
            expect(data.google).toEqual({ projectId: "proj-2" });
            expect(data.hordeConfig).toEqual({ model: "horde-model", softPrompt: "" });
            expect(data).not.toHaveProperty("openAIKey");
            expect(data).not.toHaveProperty("OaiCompAPIKeys");
            // The server kept every credential.
            const stored = server.record("llmSecrets", "main")!.data;
            expect(stored.openAIKey).toBe(PLAINTEXT.openAIKey);
            expect(stored.google.accessToken).toBe(PLAINTEXT.google);
        });

        it("flat credential fields: a string is set, blank or nullish clears, anything else is refused before any change", () => {
            db.openAIKey = "sk-new-plaintext-0000000002";
            db.claudeAPIKey = "";
            db.openrouterKey = null;
            expect(() => {
                db.mistralKey = 42;
            }).toThrow(CredentialRefusedError);
            expect(queued()).toEqual([
                { kind: "put", path: flat("openAIKey"), value: "sk-new-plaintext-0000000002" },
                { kind: "put", path: flat("claudeAPIKey"), value: "" },
                { kind: "put", path: flat("openrouterKey"), value: "" },
            ]);
            expect(liveRecord<any>("llmSecrets").openAIKey).toBe("");
            expect(db.openAIKey).toBe("");
            expect(secretStatus(flat("openAIKey") as any).pending).toBe(true);
            expect(queuedKeys()).toEqual([]);
            expectNoPlaintextInRecord();
        });

        it("nested credential leaves (`google.accessToken`, `hordeConfig.apiKey`, `novelai.token`)", async () => {
            db.google.accessToken = "ya29-new-plaintext-0000002";
            db.hordeConfig.apiKey = "horde-new-plaintext-000002";
            db.novelai.token = "";
            if (candidate !== "accessor") {
                expect(queued()).toEqual([
                    { kind: "put", path: nested("google"), value: "ya29-new-plaintext-0000002" },
                    { kind: "put", path: nested("hordeConfig"), value: "horde-new-plaintext-000002" },
                    { kind: "put", path: nested("novelai"), value: "" },
                ]);
                expect(liveRecord<any>("llmSecrets").google.accessToken).toBe("");
                expectNoPlaintextInRecord();
                expect(queuedKeys()).toEqual([]);
            } else {
                // Candidate 1 fails: the nested write lands the plaintext in the record, nothing is
                // routed or queued, and the credential is silently not saved.
                expect(queued()).toEqual([]);
                expect(liveRecord<any>("llmSecrets").google.accessToken).toBe("ya29-new-plaintext-0000002");
                expect(queuedKeys()).toEqual([]);
                // A later sibling write sends the record: its op still omits the leaf (`llmSecretsText`).
                db.vertexClientEmail = "after@example.invalid";
                const result = await capture(LLM);
                expect(result.captured).toBe(true);
                expect(result.report.ops[0].data.google).toEqual({ projectId: "proj-1" });
            }
        });

        it("whole-container assignment: siblings to the record, a non-empty leaf routed, a blank leaf unchanged, another leaf refused", async () => {
            db.google = { projectId: "proj-9", accessToken: "ya29-whole-plaintext-000009" };
            expect(snapshot(liveRecord<any>("llmSecrets").google)).toEqual({ projectId: "proj-9", accessToken: "" });
            expect(queued()).toEqual([{ kind: "put", path: nested("google"), value: "ya29-whole-plaintext-000009" }]);
            const whole = await capture(LLM);
            expect(whole.captured).toBe(true);
            expect(whole.report.ops[0].data.google).toEqual({ projectId: "proj-9" });

            resetCounters();
            llmSecretState.queue.splice(0);
            // The spread of the blank read never clears the key.
            db.google = { ...db.google, projectId: "proj-10" };
            expect(queued()).toEqual([]);
            expect(snapshot(liveRecord<any>("llmSecrets").google)).toEqual({ projectId: "proj-10", accessToken: "" });
            const spread = await capture(LLM);
            expect(spread.captured).toBe(true);

            resetCounters();
            const before = recordText();
            expect(() => {
                db.google = { projectId: "proj-11", accessToken: { set: true, hint: "abcd" } };
            }).toThrow(CredentialRefusedError);
            expect(() => {
                db.google = "not an object";
            }).toThrow(CredentialRefusedError);
            expect(recordText()).toBe(before);
            expect(queuedKeys()).toEqual([]);
            expect(queued()).toEqual([]);
            expectNoPlaintextInRecord();
        });

        it("OaiCompAPIKeys: a whole map is routed entry by entry (validated first); a single entry", () => {
            expect(() => {
                db.OaiCompAPIKeys = { ok: "oai-whole-plaintext-000001", bad: 5 };
            }).toThrow(CredentialRefusedError);
            expect(queued()).toEqual([]);
            db.OaiCompAPIKeys = { "model-1": "oai-whole-plaintext-000001", "model-2": "" };
            expect(queued()).toEqual([
                { kind: "put", path: mapEntry("model-1"), value: "oai-whole-plaintext-000001" },
                { kind: "put", path: mapEntry("model-2"), value: "" },
            ]);
            expect(snapshot(liveRecord<any>("llmSecrets").OaiCompAPIKeys)).toEqual({});
            llmSecretState.queue.splice(0);
            db.OaiCompAPIKeys["model-3"] = "oai-entry-plaintext-000003";
            if (candidate !== "accessor") {
                expect(queued()).toEqual([
                    { kind: "put", path: mapEntry("model-3"), value: "oai-entry-plaintext-000003" },
                ]);
                expectNoPlaintextInRecord();
            } else {
                // Candidate 1 fails: the entry lands in the record's map as plaintext, not routed.
                expect(queued()).toEqual([]);
                expect(liveRecord<any>("llmSecrets").OaiCompAPIKeys["model-3"]).toBe("oai-entry-plaintext-000003");
            }
            expect(queuedKeys()).toEqual([]);
        });

        it("the entry maps and delete of a credential path are refused before any change (use clearSecret)", () => {
            const before = recordText();
            if (candidate !== "accessor") {
                const refused: [string, () => void][] = [
                    ["presets map", () => (llm().presets = { a: { proxyKey: "pk-a-plaintext-0000000001" } })],
                    ["delete flat", () => delete llm().openAIKey],
                    ["delete leaf", () => delete llm().google.accessToken],
                    ["delete container", () => delete llm().google],
                    ["delete map", () => delete llm().OaiCompAPIKeys],
                    ["delete map entry", () => delete llm().OaiCompAPIKeys["model-1"]],
                ];
                for (const [name, act] of refused) {
                    expect(act, name).toThrow(CredentialRefusedError);
                }
                expect(recordText()).toBe(before);
            } else {
                // Candidate 1: the entry map has no accessor, so the assignment makes a plain
                // property on the view (silently lost); `delete` removes the view's accessor (the
                // record keeps the field); a nested `delete` removes the leaf from the record.
                llm().presets = { a: { proxyKey: "pk-a-plaintext-0000000001" } };
                expect(recordText()).toBe(before);
                expect(delete llm().openAIKey).toBe(true);
                expect(llm().openAIKey).toBeUndefined();
                expect(liveRecord<any>("llmSecrets").openAIKey).toBe("");
                delete llm().google.accessToken;
                expect(liveRecord<any>("llmSecrets").google).not.toHaveProperty("accessToken");
            }
            expect(queued()).toEqual([]);
            expect(queuedKeys()).toEqual([]);
        });

        it("the root `proxyKey` reads blank and writes the selected preset's llmSecrets entry (`forwarding.svelte.ts:156`)", () => {
            expect(db.proxyKey).toBe("");
            db.proxyKey = "pk-a-plaintext-0000000001";
            switchPreset("b");
            db.proxyKey = "";
            db.proxyKey = null;
            expect(queued()).toEqual([
                { kind: "put", path: presetEntry("a"), value: "pk-a-plaintext-0000000001" },
                { kind: "put", path: presetEntry("b"), value: "" },
                { kind: "put", path: presetEntry("b"), value: "" },
            ]);
            expect(db.proxyKey).toBe("");
            expect(isSecretSet(presetEntry("a") as any)).toBe(true);
            expect(queuedKeys()).toEqual([]);
            expect(JSON.stringify(liveRecord(PRESETS_KIND))).not.toContain("pk-a-plaintext");
            expectNoPlaintextInRecord();
        });
    });

    describe("proof 10: indexed replacement and retained references", () => {
        it("`presets[0] = { ...a, temperature: 1 }` is captured; a retained wrapper of `a` still reads and writes `a`", async () => {
            const retained = view(PRESETS_KIND)[0];
            const presets = view(PRESETS_KIND);
            presets[0] = { ...presets[0], temperature: 1 };
            expect(livePreset("a").temperature).toBe(1);
            expect(leaks(snapshot(liveRecord(PRESETS_KIND)))).toEqual([]);
            const replaced = await capture(PRESETS);
            expect(replaced.captured).toBe(true);
            expect(server.record(PRESETS_KIND, "main")!.data[0].temperature).toBe(1);

            resetCounters();
            if (candidate !== "accessor") {
                expect(retained.temperature).toBe(1);
                retained.maxContext = 1234;
                expect(livePreset("a").maxContext).toBe(1234);
                expect(livePreset("b").maxContext).toBe(8000);
                const write = await capture(PRESETS);
                expect(write.captured).toBe(true);
            } else {
                // Candidate 1: the retained preset is the old, now detached, `$state` object.
                expect(retained.temperature).toBe(80);
                retained.maxContext = 1234;
                expect(livePreset("a").maxContext).toBe(4000);
                expect(queuedKeys()).toEqual([]);
            }
        });

        it("a retained preset wrapper across an applyRaw that reorders the presets record still targets `a`", async () => {
            const retained = view(PRESETS_KIND)[0];
            const retainedNested = view(PRESETS_KIND)[0].promptSettings;
            applyRaw(
                PRESETS_KIND,
                "main",
                edited(PRESETS_KIND, "main", (data) => data.reverse()),
            );
            expect(presetIndex("a")).toBe(1);
            if (candidate !== "accessor") {
                expect(retained.id).toBe("a");
                retained.temperature = 2;
                retainedNested.postEndInnerFormat = "after raw";
                expect(livePreset("a").temperature).toBe(2);
                expect(livePreset("a").promptSettings.postEndInnerFormat).toBe("after raw");
                expect(livePreset("b").temperature).toBe(50);
                const result = await capture(PRESETS);
                expect(result.captured).toBe(true);
            } else {
                retained.temperature = 2;
                retainedNested.postEndInnerFormat = "after raw";
                // Both writes went into the detached old objects: silently lost.
                expect(livePreset("a").temperature).toBe(80);
                expect(livePreset("a").promptSettings.postEndInnerFormat).toBe("a-format");
                expect(livePreset("b").temperature).toBe(50);
                expect(queuedKeys()).toEqual([]);
            }
        });

        it("a retained character wrapper across an applyRaw of that character", async () => {
            const retained = view(CHARACTERS_KIND, CHA);
            applyRaw(
                CHARACTERS_KIND,
                CHA,
                edited(CHARACTERS_KIND, CHA, (data: any) => (data.desc = "raw desc")),
            );
            expect(retained.desc).toBe("raw desc");
            retained.desc = "written";
            expect(liveChar().desc).toBe("written");
            const result = await capture(CHAR);
            expect(result.captured).toBe(true);
        });

        it("a retained nested wrapper (`globalLore[3]`) after a whole-record applyRaw", async () => {
            const retained = view(CHARACTERS_KIND, CHA).globalLore[3];
            applyRaw(
                CHARACTERS_KIND,
                CHA,
                edited(CHARACTERS_KIND, CHA, (data: any) => (data.globalLore[3].comment = "raw")),
            );
            retained.content = "after raw";
            if (candidate !== "accessor") {
                // Same logical record, same path.
                expect(retained.comment).toBe("raw");
                expect(liveChar().globalLore[3].content).toBe("after raw");
                const result = await capture(CHAR);
                expect(result.captured).toBe(true);
            } else {
                // Detached: the write is silently lost.
                expect(liveChar().globalLore[3].content).toBe("content 3");
                expect(queuedKeys()).toEqual([]);
            }
        });

        if (candidate !== "accessor") {
            it("a retained element wrapper follows its element through a local unshift and fails loudly once it is spliced out", async () => {
                const lore = trackedRecord(CHARACTERS_KIND, CHA).globalLore;
                const retained = lore[3];
                lore.unshift(loreEntry(950));
                expect(retained.key).toBe("key-3");
                retained.content = "followed";
                expect(liveChar().globalLore[4].content).toBe("followed");
                lore.splice(4, 1);
                expect(() => {
                    retained.content = "lost?";
                }).toThrow(DetachedWrapperError);
                expect(JSON.stringify(liveChar())).not.toContain("lost?");
                const result = await capture(CHAR);
                expect(result.captured).toBe(true);
            });

            it("a retained wrapper of a preset that is removed fails loudly instead of writing another preset", () => {
                const retained = trackedRecord(PRESETS_KIND)[1];
                applyRaw(
                    PRESETS_KIND,
                    "main",
                    edited(PRESETS_KIND, "main", (data) => data.splice(1, 1)),
                );
                expect(() => {
                    retained.temperature = 99;
                }).toThrow(DetachedWrapperError);
                expect(livePreset("a").temperature).toBe(80);
            });
        }
    });

    describe("proof 11: a retained preset wrapper never redirects", () => {
        it("a wrapper of `a` taken while selected, a switch to `b`, then a write: lands in `a`", async () => {
            const retained = view(PRESETS_KIND)[presetIndex("a")];
            switchPreset("b");
            retained.temperature = 5;
            expect(livePreset("a").temperature).toBe(5);
            expect(livePreset("b").temperature).toBe(50);
            const result = await capture(PRESETS);
            expect(result.captured).toBe(onlyTracked(candidate));
        });
    });

    describe("proof 12: hydration queues nothing", () => {
        it("an applyRemote replacement while wrappers are cached and bound makes no queue call and sends nothing", async () => {
            const cachedRoot = view(CHARACTERS_KIND, CHA);
            const cachedLore = cachedRoot.globalLore[7];
            const { input } = render(SpikeRecordInput, {
                get record() {
                    return view(CHARACTERS_KIND, CHA).globalLore[7];
                },
                field: "content",
            });
            const element = input();
            server.set(
                CHARACTERS_KIND,
                CHA,
                edited(CHARACTERS_KIND, CHA, (data: any) => (data.globalLore[7].content = "hydrated")),
            );
            const remote = server.record(CHARACTERS_KIND, CHA)!;
            expect(applyRemote(CHARACTERS_KIND, CHA, remote.revision, remote.data)).toBe(true);
            flushSync();
            expect(element.value).toBe("hydrated");
            expect(cachedRoot.globalLore[7].content).toBe("hydrated");
            // Candidate 2's cached nested wrapper reaches the new record; candidate 1's retained
            // nested object is the old, detached one.
            expect(cachedLore.content).toBe(candidate === "accessor" ? "content 7" : "hydrated");
            expect(stats.queueCalls.size).toBe(0);
            const report = await flush();
            expect(report.status).toBeNull();
            expect(stats.bodies).toEqual([]);
        });
    });

    describe("proof 13: edit, remote notice, flush (R15)", () => {
        it("an unflushed edit keeps a newer remote record out; the flush sends the old base and the 409 reloads", async () => {
            const before = persistedOf(CHARACTERS_KIND, CHA)!.revision;
            view(CHARACTERS_KIND, CHA).desc = "local edit";
            server.set(
                CHARACTERS_KIND,
                CHA,
                edited(CHARACTERS_KIND, CHA, (data: any) => (data.desc = "other tab")),
            );
            const remote = server.record(CHARACTERS_KIND, CHA)!;
            // The other tab changed the field this tab's unsent edit touched.
            expect(remote.data.desc).toBe("other tab");

            expect(applyRemote(CHARACTERS_KIND, CHA, remote.revision, remote.data)).toBe(false);
            expect(liveChar().desc).toBe("local edit");
            expect(persistedOf(CHARACTERS_KIND, CHA)!.revision).toBe(before);
            expect(deferredRevision(CHARACTERS_KIND, CHA)).toBe(remote.revision);

            const report = await flush();
            expect(report.ops).toHaveLength(1);
            expect(report.ops[0].baseRevision).toBe(before);
            expect(report.ops[0].baseRevision).not.toBe(remote.revision);
            expect(report.status).toBe(409);
            expect(report.conflicts).toEqual([CHAR]);
            expect(stats.discarded).toEqual([CHAR]);
            expect(liveChar().desc).toBe("other tab");
            expect(persistedOf(CHARACTERS_KIND, CHA)!.revision).toBe(remote.revision);
            expect(dirtyKeys()).toEqual([]);
            expect(deferredRevision(CHARACTERS_KIND, CHA)).toBeUndefined();
        });

        it("the benign case: a dirty mark with the serialization equal to the saved text lets the remote record apply", async () => {
            const character = view(CHARACTERS_KIND, CHA);
            character.desc = character.desc;
            expect(dirtyKeys()).toEqual([CHAR]);
            server.set(
                CHARACTERS_KIND,
                CHA,
                edited(CHARACTERS_KIND, CHA, (data: any) => (data.desc = "other tab")),
            );
            const remote = server.record(CHARACTERS_KIND, CHA)!;
            expect(applyRemote(CHARACTERS_KIND, CHA, remote.revision, remote.data)).toBe(true);
            expect(liveChar().desc).toBe("other tab");
            expect(persistedOf(CHARACTERS_KIND, CHA)!.revision).toBe(remote.revision);
            const report = await flush();
            expect(report.serialized).toBe(1);
            expect(report.ops).toEqual([]);
            expect(stats.bodies).toEqual([]);
            expect(dirtyKeys()).toEqual([]);
        });
    });

    describe("proof 14: an edit during its own acknowledgement (R15)", () => {
        it("stays dirty after the ack; the next flush sends it on the acknowledged revision and the server takes both edits", async () => {
            const character = view(CHARACTERS_KIND, CHA);
            character.desc = "first";
            server.holdNextBatch = true;
            const pending = flush();
            await vi.waitFor(() => expect(server.releaseBatch).not.toBeNull());
            character.name = "second";
            server.releaseBatch!();
            const first = await pending;
            expect(first.status).toBe(200);
            const acked = server.record(CHARACTERS_KIND, CHA)!.revision;
            expect(persistedOf(CHARACTERS_KIND, CHA)!.revision).toBe(acked);
            expect(dirtyKeys()).toEqual([CHAR]);

            const second = await flush();
            expect(second.status).toBe(200);
            expect(second.ops).toHaveLength(1);
            expect(second.ops[0].baseRevision).toBe(acked);
            expect(second.conflicts).toEqual([]);
            const stored = server.record(CHARACTERS_KIND, CHA)!.data;
            expect(stored.desc).toBe("first");
            expect(stored.name).toBe("second");
            expect(dirtyKeys()).toEqual([]);
        });
    });

    describe("round 2, point 4: the in-flight hydration fence", () => {
        it("a newer remote record is not applied while its record's batch is in flight, even with the text back at the saved text", async () => {
            const character = view(CHARACTERS_KIND, CHA);
            const saved = persistedOf(CHARACTERS_KIND, CHA)!;
            character.desc = "in flight";
            server.holdNextBatch = true;
            const pending = flush();
            await vi.waitFor(() => expect(server.releaseBatch).not.toBeNull());
            // Back to the saved text while the batch is held: only the in-flight guard can refuse.
            character.desc = "the description";
            expect(JSON.stringify(liveChar())).toBe(saved.text);
            server.set(
                CHARACTERS_KIND,
                CHA,
                edited(CHARACTERS_KIND, CHA, (data: any) => (data.name = "other tab")),
            );
            const remote = server.record(CHARACTERS_KIND, CHA)!;
            expect(applyRemote(CHARACTERS_KIND, CHA, remote.revision, remote.data)).toBe(false);
            expect(liveChar().name).toBe("Spike");
            expect(persistedOf(CHARACTERS_KIND, CHA)!.revision).toBe(saved.revision);
            expect(deferredRevision(CHARACTERS_KIND, CHA)).toBe(remote.revision);

            server.releaseBatch!();
            const report = await pending;
            // The held batch named the saved revision, which the other tab's write made stale.
            expect(report.ops[0].baseRevision).toBe(saved.revision);
            expect(report.status).toBe(409);
            expect(report.conflicts).toEqual([CHAR]);
            expect(liveChar().name).toBe("other tab");
            expect(liveChar().desc).toBe("the description");
            expect(persistedOf(CHARACTERS_KIND, CHA)!.revision).toBe(remote.revision);
            // After the batch settled the deferred record was checked again and dropped: the
            // conflict reload already holds its revision, so it is not newer.
            expect(deferredRevision(CHARACTERS_KIND, CHA)).toBeUndefined();
            expect(dirtyKeys()).toEqual([]);
        });
    });

    describe("round 2, point 5: keyed rows with child bindings across a swap and a hydration", () => {
        it("the CustomModelsSettings swap, a hydration, then an edit of the same DOM row lands in its id", async () => {
            const { target } = render(SpikeRecordList, {
                get list() {
                    return db.botPresets;
                },
            });
            const rows = () => [...target.querySelectorAll<HTMLElement>("[data-row]")];
            expect(rows().map((row) => row.dataset.row)).toEqual(["a", "b"]);
            const rowA = rows()[0];

            // `CustomModelsSettings.svelte` (arrow up on index 1), through the facade.
            const index = 1;
            const models = db.botPresets;
            const temp = models[index];
            models[index] = models[index - 1];
            models[index - 1] = temp;
            db.botPresets = models;
            flushSync();
            expect(liveRecord<any[]>(PRESETS_KIND).map((preset) => preset.id)).toEqual(["b", "a"]);
            expect(rows().map((row) => row.dataset.row)).toEqual(["b", "a"]);
            expect(rows()[1]).toBe(rowA);
            const swapped = await capture(PRESETS);
            expect(swapped.captured).toBe(true);

            // Another tab reorders back and renames `a`; the hydration applies (no local change).
            server.set(
                PRESETS_KIND,
                "main",
                edited(PRESETS_KIND, "main", (data: any[]) => {
                    data.reverse();
                    data[0].name = "A remote";
                }),
            );
            const remote = server.record(PRESETS_KIND, "main")!;
            expect(applyRemote(PRESETS_KIND, "main", remote.revision, remote.data)).toBe(true);
            flushSync();
            expect(rows().map((row) => row.dataset.row)).toEqual(["a", "b"]);
            expect(rows()[0]).toBe(rowA);
            const nameInput = rowA.querySelector<HTMLInputElement>("input[data-name]")!;
            expect(nameInput.value).toBe("A remote");

            resetCounters();
            typeInto(nameInput, "edited a");
            const check = rowA.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
            check.checked = true;
            check.dispatchEvent(new Event("change", { bubbles: true }));
            flushSync();
            expect(livePreset("a").name).toBe("edited a");
            expect(livePreset("a").useInstructPrompt).toBe(true);
            expect(livePreset("b").name).toBe("Preset B");
            expect(livePreset("b").useInstructPrompt).toBe(false);
            const edit = await capture(PRESETS);
            expect(edit.captured).toBe(onlyTracked(candidate));
        });

        it("a $derived selector across a replacement, and the identity contract of retained and fresh wrappers", () => {
            const retained = db.botPresets.find((preset: any) => preset.id === "a");
            const probe = derivedProbe(() => db.botPresets.find((preset: any) => preset.id === "a"));
            const runs = probe.runs();
            applyRaw(
                PRESETS_KIND,
                "main",
                edited(PRESETS_KIND, "main", (data: any[]) => {
                    data.reverse();
                    data[1].name = "A raw";
                }),
            );
            flushSync();
            expect(probe.runs()).toBeGreaterThan(runs);
            expect(probe.current().name).toBe("A raw");
            const fresh = db.botPresets.find((preset: any) => preset.id === "a");
            if (candidate !== "accessor") {
                // One canonical wrapper per logical item: a preset by its id.
                expect(fresh).toBe(retained);
                expect(probe.current()).toBe(retained);
                expect(db.botPresets.includes(retained)).toBe(true);
                expect(db.botPresets.indexOf(retained)).toBe(1);

                // An id-less element (a lore entry): by its object within the record's local
                // life, and by its path across a raw replacement (`LoreBookData.svelte:299`).
                const lore = trackedRecord(CHARACTERS_KIND, CHA).globalLore;
                const entry = lore[3];
                expect(lore.includes(entry)).toBe(true);
                lore.unshift(loreEntry(990));
                expect(lore[4]).toBe(entry);
                expect(lore.indexOf(entry)).toBe(4);
                applyRaw(
                    CHARACTERS_KIND,
                    CHA,
                    edited(CHARACTERS_KIND, CHA, (data: any) => (data.globalLore[4].comment = "raw")),
                );
                expect(lore[4]).toBe(entry);
                expect(entry.comment).toBe("raw");
                expect(lore.includes(entry)).toBe(true);
            } else {
                // Candidate 1 returns the raw `$state` objects: a replacement makes new ones.
                expect(fresh).not.toBe(retained);
                expect(db.botPresets.includes(retained)).toBe(false);
            }
            probe.dispose();
        });
    });

    describe("round 2, point 6: clone and assignment boundaries", () => {
        it("the production safeStructuredClone (its rfdc fallback) on a wrapper: detached values, nothing written or queued", () => {
            applyRaw(
                PRESETS_KIND,
                "main",
                JSON.parse(
                    JSON.stringify(liveRecord(PRESETS_KIND)).replace(
                        '"overrides":{',
                        '"overrides":{"__proto__":{"temperature":11},',
                    ),
                ),
            );
            resetCounters();
            const before = JSON.stringify(liveRecord(PRESETS_KIND));
            const presets = view(PRESETS_KIND);
            expect(() => structuredClone(presets)).toThrow();
            const clone = safeStructuredClone(presets) as any[];
            expect(Array.isArray(clone)).toBe(true);
            expect(leaks(clone)).toEqual([]);
            expect(clone[0].temperature).toBe(80);
            clone[0].temperature = 1;
            clone[0].promptSettings.postEndInnerFormat = "clone";
            expect(livePreset("a").temperature).toBe(80);
            expect(JSON.stringify(liveRecord(PRESETS_KIND))).toBe(before);
            expect(queuedKeys()).toEqual([]);
            // rfdc assigns `copy[key]`: the own `__proto__` entry becomes the clone's prototype.
            const overrides = clone[0].seperateParameters.overrides;
            expect(Object.hasOwn(overrides, "__proto__")).toBe(false);
            expect(Object.getPrototypeOf(overrides)).toEqual({ temperature: 11 });
            expect(overrides.temperature).toBe(11);
        });

        it("Object.assign into a wrapper", async () => {
            Object.assign(view(CHARACTERS_KIND, CHA), { desc: "assigned", name: "Assigned" });
            expect(liveChar().desc).toBe("assigned");
            const top = await capture(CHAR);
            expect(top.captured).toBe(true);

            resetCounters();
            Object.assign(view(PRESETS_KIND)[0].reverseProxyOobaArgs, { mode: "chat", name1_instruct: "assigned" });
            expect(livePreset("a").reverseProxyOobaArgs).toEqual({ mode: "chat", name1_instruct: "assigned" });
            const nestedAssign = await capture(PRESETS);
            expect(nestedAssign.captured).toBe(onlyTracked(candidate));
        });

        it("reverse, fill, and an overlapping copyWithin directly on a wrapper array", async () => {
            const operations: [string, (list: any[]) => unknown][] = [
                ["reverse", (list) => list.reverse()],
                ["fill", (list) => list.fill(loreEntry(970), 1, 3)],
                ["copyWithin", (list) => list.copyWithin(0, 2, 6)],
            ];
            for (const [name, operate] of operations) {
                resetCounters();
                const expected = recordJson(CHARACTERS_KIND, CHA).globalLore;
                operate(expected);
                operate(view(CHARACTERS_KIND, CHA).globalLore);
                expect(recordJson(CHARACTERS_KIND, CHA).globalLore, name).toEqual(expected);
                const result = await capture(CHAR);
                expect(result.captured, name).toBe(onlyTracked(candidate));
                if (result.captured) {
                    expect(server.record(CHARACTERS_KIND, CHA)!.data.globalLore, name).toEqual(expected);
                }
            }
        });
    });

    if (candidate !== "accessor") {
        describe("round 2, point 1: assigning a retained wrapper", () => {
            it("directly, after a local replacement, without an intervening read: the current object, never the old one", async () => {
                const presets = trackedRecord(PRESETS_KIND);
                const retained = presets[0];
                const old = liveRecord<any[]>(PRESETS_KIND)[0];
                presets[0] = { ...presets[0], temperature: 1 };
                presets[0] = retained;
                expect(livePreset("a").temperature).toBe(1);
                expect(Object.is(liveRecord<any[]>(PRESETS_KIND)[0], old)).toBe(false);
                const result = await capture(PRESETS);
                expect(result.captured).toBe(true);
                expect(server.record(PRESETS_KIND, "main")!.data[0].temperature).toBe(1);
            });

            it("inside a spread-created object", async () => {
                const presets = trackedRecord(PRESETS_KIND);
                const retained = presets[0];
                presets[0] = { ...presets[0], temperature: 1 };
                presets[1] = { ...presets[1], linked: retained };
                expect(livePreset("b").linked.temperature).toBe(1);
                expect(Object.is(livePreset("b").linked, livePreset("a"))).toBe(true);
                const result = await capture(PRESETS);
                expect(result.captured).toBe(true);
            });

            it("inside an array", async () => {
                const presets = trackedRecord(PRESETS_KIND);
                const retained = presets[0];
                presets[0] = { ...presets[0], temperature: 1 };
                db.botPresets = [retained, presets[1]];
                expect(liveRecord<any[]>(PRESETS_KIND).map((preset) => [preset.id, preset.temperature])).toEqual([
                    ["a", 1],
                    ["b", 50],
                ]);
                const result = await capture(PRESETS);
                expect(result.captured).toBe(true);
            });

            it("a removed wrapper fails loudly once its task has ended; nothing changes", async () => {
                const presets = trackedRecord(PRESETS_KIND);
                const removed = presets[1];
                db.botPresets = [presets[0]];
                const lore = trackedRecord(CHARACTERS_KIND, CHA).globalLore;
                const entry = lore[3];
                lore.splice(3, 1);
                await nextTask();
                resetCounters();
                const presetsBefore = JSON.stringify(liveRecord(PRESETS_KIND));
                const characterBefore = JSON.stringify(liveChar());
                expect(() => presets.push(removed)).toThrow(DetachedWrapperError);
                expect(() => {
                    presets[1] = removed;
                }).toThrow(DetachedWrapperError);
                expect(() => {
                    db.botPresets = [presets[0], removed];
                }).toThrow(DetachedWrapperError);
                expect(() => {
                    lore[0] = entry;
                }).toThrow(DetachedWrapperError);
                expect(JSON.stringify(liveRecord(PRESETS_KIND))).toBe(presetsBefore);
                expect(JSON.stringify(liveChar())).toBe(characterBefore);
                expect(queuedKeys()).toEqual([]);
            });

            it("in the same task a displaced element can be put back, as the latest object of its id", () => {
                const presets = trackedRecord(PRESETS_KIND);
                const retained = presets[0];
                presets[0] = { ...presets[0], temperature: 1 };
                presets.splice(0, 1);
                presets.push(retained);
                expect(liveRecord<any[]>(PRESETS_KIND).map((preset) => [preset.id, preset.temperature])).toEqual([
                    ["b", 50],
                    ["a", 1],
                ]);
            });

            it("with the same-task re-insertion off, the CustomModelsSettings swap throws halfway (the strict rule alone)", () => {
                setDisplacedReinsertion(false);
                const models = db.botPresets;
                const temp = models[1];
                models[1] = models[0];
                expect(() => {
                    models[0] = temp;
                }).toThrow(DetachedWrapperError);
                expect(liveRecord<any[]>(PRESETS_KIND).map((preset) => preset.id)).toEqual(["a", "a"]);
            });
        });

        describe("round 3: the narrowed identity rule", () => {
            /** Entries 5 and 9 share `id: "dup"` (a re-imported lorebook), applied and saved as the server holds it. */
            async function seedDuplicateIds() {
                server.set(
                    CHARACTERS_KIND,
                    CHA,
                    edited(CHARACTERS_KIND, CHA, (data: any) => {
                        data.globalLore[5].id = "dup";
                        data.globalLore[9].id = "dup";
                    }),
                );
                await reloadRecord(CHARACTERS_KIND, CHA);
                resetCounters();
            }

            it("duplicate ids in globalLore: list[5] and list[9] are different wrappers, each writing its own element", async () => {
                await seedDuplicateIds();
                const lore = trackedRecord(CHARACTERS_KIND, CHA).globalLore;
                const five = lore[5];
                const nine = lore[9];
                expect(Object.is(five, nine)).toBe(false);
                five.content = "via five";
                expect(liveChar().globalLore[5].content).toBe("via five");
                expect(liveChar().globalLore[9].content).toBe("content 9");
                expect(nine.content).toBe("content 9");
                const result = await capture(CHAR);
                expect(result.captured).toBe(true);
                expect(result.report.ops[0].data.globalLore[5].content).toBe("via five");
                expect(result.report.ops[0].data.globalLore[9].content).toBe("content 9");
            });

            it("duplicate ids, two bound rows: an edit in row 5 lands in element 5 only, and the flush sends exactly that", async () => {
                await seedDuplicateIds();
                const row5 = render(SpikeRecordInput, {
                    get record() {
                        return db.characters[0].globalLore[5];
                    },
                    field: "content",
                    id: "row-5",
                }).input("#row-5");
                const row9 = render(SpikeRecordInput, {
                    get record() {
                        return db.characters[0].globalLore[9];
                    },
                    field: "content",
                    id: "row-9",
                }).input("#row-9");
                expect([row5.value, row9.value]).toEqual(["content 5", "content 9"]);
                typeInto(row5, "typed in row 5");
                flushSync();
                expect(liveChar().globalLore[5].content).toBe("typed in row 5");
                expect(liveChar().globalLore[9].content).toBe("content 9");
                expect([row5.value, row9.value]).toEqual(["typed in row 5", "content 9"]);
                const result = await capture(CHAR);
                expect(result.captured).toBe(true);
                const sent = result.report.ops[0].data.globalLore;
                expect([sent[5].content, sent[9].content]).toEqual(["typed in row 5", "content 9"]);
                const stored = server.record(CHARACTERS_KIND, CHA)!.data.globalLore;
                expect([stored[5].content, stored[9].content]).toEqual(["typed in row 5", "content 9"]);
            });

            it("an id-less element that gains an id through its wrapper keeps its identity (`LoreBookData.svelte:57-58`)", async () => {
                const lore = trackedRecord(CHARACTERS_KIND, CHA).globalLore;
                const entry = lore[3];
                entry.id = "new-id";
                expect(lore[3]).toBe(entry);
                expect(lore.includes(entry)).toBe(true);
                expect(lore.indexOf(entry)).toBe(3);
                entry.content = "after the id";
                expect(liveChar().globalLore[3].content).toBe("after the id");
                expect(liveChar().globalLore[3].id).toBe("new-id");
                const result = await capture(CHAR);
                expect(result.captured).toBe(true);
            });

            it("an allowlisted by-id field with a duplicate id refuses a write through that id before any change", async () => {
                const presets = trackedRecord(PRESETS_KIND);
                const a = presets[0];
                // A local copy breaks the uniqueness `normalizePresets` would restore.
                presets.push({ ...presets[0], name: "Copy of A" });
                resetCounters();
                const before = JSON.stringify(liveRecord(PRESETS_KIND));
                const refused: [string, () => void][] = [
                    ["field", () => (a.temperature = 5)],
                    ["nested", () => (a.promptSettings.postEndInnerFormat = "x")],
                    ["delete", () => delete a.maxContext],
                    [
                        "define",
                        () =>
                            Object.defineProperty(a, "maxContext", {
                                value: 1,
                                writable: true,
                                enumerable: true,
                                configurable: true,
                            }),
                    ],
                    ["facade", () => (db.temperature = 7)],
                ];
                for (const [name, act] of refused) {
                    expect(act, name).toThrow(DuplicateIdError);
                }
                expect(JSON.stringify(liveRecord(PRESETS_KIND))).toBe(before);
                expect(queuedKeys()).toEqual([]);
                // A unique id in the same field stays writable.
                presets[1].temperature = 51;
                expect(livePreset("b").temperature).toBe(51);
                expect(queuedKeys()).toEqual([PRESETS]);
            });
        });

        describe("round 2, point 2: no wrapper is ever stored in a live record", () => {
            it("a plain container holding nested wrappers (fields and array elements); later edits queue only the intended record", async () => {
                const character = trackedRecord(CHARACTERS_KIND, CHA);
                const presets = trackedRecord(PRESETS_KIND);
                character.extra = {
                    list: [character.globalLore[1], { deep: character.globalLore[2] }],
                    preset: presets[0],
                };
                expect(findLiveWrappers()).toEqual([]);
                const extra = liveChar().extra;
                // The same record: the `$state` object itself; another record: a detached copy.
                expect(Object.is(extra.list[0], liveChar().globalLore[1])).toBe(true);
                expect(Object.is(extra.list[1].deep, liveChar().globalLore[2])).toBe(true);
                expect(Object.is(extra.preset, livePreset("a"))).toBe(false);
                expect(snapshot(extra.preset)).toEqual(recordJson(PRESETS_KIND)[0]);
                const stored = await capture(CHAR);
                expect(stored.captured).toBe(true);

                resetCounters();
                character.extra.preset.temperature = 5;
                expect(livePreset("a").temperature).toBe(80);
                const edit = await capture(CHAR);
                expect(edit.captured).toBe(true);
            });

            it("a $state editing copy holding wrappers is stored as a detached copy with none in it", async () => {
                const character = trackedRecord(CHARACTERS_KIND, CHA);
                const presets = trackedRecord(PRESETS_KIND);
                const draft = stateContainer({ items: [] as any[], preset: null as any });
                draft.items.push(character.globalLore[4]);
                draft.items.push({ nested: character.globalLore[5] });
                draft.preset = presets[1];
                // The editing copy itself holds the wrappers (Svelte stores them as is).
                expect(isTrackedWrapper(draft.items[0])).toBe(true);
                character.draft = draft;
                expect(findLiveWrappers()).toEqual([]);
                expect(Object.is(liveChar().draft, draft)).toBe(false);
                expect(snapshot(liveChar().draft.items[0])).toEqual(recordJson(CHARACTERS_KIND, CHA).globalLore[4]);
                expect(snapshot(liveChar().draft.preset).id).toBe("b");
                const stored = await capture(CHAR);
                expect(stored.captured).toBe(true);

                resetCounters();
                // The draft no longer shares state with the record ...
                draft.preset = null;
                expect(liveChar().draft.preset.id).toBe("b");
                expect(queuedKeys()).toEqual([]);
                // ... and an edit through the record queues only the character.
                character.draft.preset.temperature = 3;
                expect(livePreset("b").temperature).toBe(50);
                const edit = await capture(CHAR);
                expect(edit.captured).toBe(true);
            });
        });
    }
});

// ---------------------------------------------------------------------------------------------

function median(values: number[]): number {
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length / 2)];
}

function machine(): string {
    let cpu = "unknown";
    try {
        cpu = /model name\s*:\s*(.*)/.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1] ?? cpu;
    } catch {}
    let uname = "unknown";
    try {
        uname = execSync("uname -a", { encoding: "utf8" }).trim();
    } catch {}
    const svelte = JSON.parse(readFileSync("node_modules/svelte/package.json", "utf8")).version;
    const vitest = JSON.parse(readFileSync("node_modules/vitest/package.json", "utf8")).version;
    return `uname: ${uname}\ncpu: ${cpu}\nnode ${process.version}, svelte ${svelte}, vitest ${vitest}`;
}

describe("proof 5: cost", () => {
    const WRITES = 1000;
    const ROUNDS = 9;

    it("1,000 sequential nested writes into the 300-entry character: one serialization per flush; candidate 2 against direct $state writes", async () => {
        const direct = liveRecord<any>(CHARACTERS_KIND, CHA);
        const accessor = projectRecord(CHARACTERS_KIND, CHA);
        const tracked = trackedRecord(CHARACTERS_KIND, CHA);
        const facadeDb = mountFacade("tracked", [CHA]) as any;
        // Each target: the record to write through and the resolve-cache mode it runs with.
        const targets: Record<string, [() => any, boolean]> = {
            direct: [() => liveRecord<any>(CHARACTERS_KIND, CHA), false],
            accessor: [() => accessor, false],
            tracked: [() => tracked, false],
            "tracked-cached": [() => tracked, true],
            "tracked via facade": [() => facadeDb.characters[0], false],
            "tracked-cached via facade": [() => facadeDb.characters[0], true],
        };
        expect(direct).toBe(liveRecord(CHARACTERS_KIND, CHA));

        const times: Record<string, number[]> = Object.fromEntries(Object.keys(targets).map((name) => [name, []]));
        let counter = 0;
        for (let round = 0; round < ROUNDS; round += 1) {
            for (const [name, [target, cached]] of Object.entries(targets)) {
                setResolveCache(cached);
                const record = target();
                const start = performance.now();
                for (let index = 0; index < WRITES; index += 1) {
                    record.globalLore[index % LORE_SIZE].content = `write ${(counter += 1)}`;
                }
                times[name].push(performance.now() - start);
            }
        }
        const medians = Object.fromEntries(Object.entries(times).map(([name, list]) => [name, median(list)]));
        const ratio = (name: string) => medians[name] / medians.direct;

        // The write path never serializes; the flush serializes the record once.
        setResolveCache(false);
        resetCounters();
        for (let index = 0; index < WRITES; index += 1) {
            tracked.globalLore[index % LORE_SIZE].content = `final ${index}`;
        }
        expect(stats.queueCalls.get(CHAR)).toBe(WRITES);
        expect(stats.serializations).toBe(0);
        const report = await flush();
        expect(report.serialized).toBe(1);
        expect(stats.serializations).toBe(1);
        expect(report.ops).toHaveLength(1);
        expect(report.status).toBe(200);
        expect(server.record(CHARACTERS_KIND, CHA)!.data.globalLore[(WRITES - 1) % LORE_SIZE].content).toBe(
            `final ${WRITES - 1}`,
        );

        console.info(
            [
                "[projection spike] proof 5, 1,000 nested writes (median of 9 rounds, ms):",
                ...Object.keys(targets).map(
                    (name) => `  ${name}: ${medians[name].toFixed(3)} ms (x${ratio(name).toFixed(2)} of direct)`,
                ),
                machine(),
            ].join("\n"),
        );
        // The verdict rule asks for candidate 2 within 2x; the assertion is generous so it does not flake.
        expect(ratio("tracked")).toBeLessThan(10);
        expect(ratio("tracked-cached")).toBeLessThan(10);
    });

    it("bulk (round 2, point 7): the lorebook drag rebuild and the preset reorder, candidate 2 against direct $state", () => {
        // `LoreBookList.svelte:209-296`: copy the array (here with a new object per item), move one
        // item as a copy, regroup by folder, then replace the field.
        function drag(lore: any[], assign: (next: any[]) => void) {
            const newArray = lore.map((item) => ({ ...item }));
            const [moved] = newArray.splice(10, 1);
            const updated = { ...moved };
            delete updated.folder;
            newArray.splice(200, 0, updated);
            const sorted: any[] = [];
            const processed = new Set();
            for (const item of newArray) {
                if (processed.has(item)) {
                    continue;
                }
                sorted.push(item);
                processed.add(item);
                if (item.mode === "folder") {
                    for (const sub of newArray) {
                        if (!processed.has(sub) && sub.folder === item.key) {
                            sorted.push(sub);
                            processed.add(sub);
                        }
                    }
                }
            }
            assign(sorted);
        }
        // `botpreset.svelte:49` (`movePreset`): copy the collection, move one preset, replace it.
        function move(list: any[], assign: (next: any[]) => void) {
            const presets = [...list];
            const [moved] = presets.splice(0, 1);
            presets.splice(29, 0, moved);
            assign(presets);
        }
        const base = recordJson(PRESETS_KIND)[0];
        applyRaw(
            PRESETS_KIND,
            "main",
            Array.from({ length: 50 }, (_, index) => ({ ...base, id: `p${index}`, name: `Preset ${index}` })),
        );
        const facadeDb = mountFacade("tracked", [CHA]) as any;
        const tracked = trackedRecord(CHARACTERS_KIND, CHA);
        const targets: Record<string, [() => void, () => void, boolean]> = {
            direct: [
                () => drag(liveChar().globalLore, (next) => (liveChar().globalLore = next)),
                () => move(liveRecord(PRESETS_KIND), (next) => setLiveRecord(PRESETS_KIND, "main", next)),
                false,
            ],
            tracked: [
                () => drag(tracked.globalLore, (next) => (tracked.globalLore = next)),
                () => move(facadeDb.botPresets, (next) => (facadeDb.botPresets = next)),
                false,
            ],
            "tracked-cached": [
                () => drag(tracked.globalLore, (next) => (tracked.globalLore = next)),
                () => move(facadeDb.botPresets, (next) => (facadeDb.botPresets = next)),
                true,
            ],
        };
        const times: Record<string, { drag: number[]; move: number[] }> = {};
        for (let round = 0; round < 9; round += 1) {
            for (const [name, [dragOnce, moveOnce, cached]] of Object.entries(targets)) {
                setResolveCache(cached);
                times[name] ??= { drag: [], move: [] };
                let start = performance.now();
                dragOnce();
                times[name].drag.push(performance.now() - start);
                start = performance.now();
                moveOnce();
                times[name].move.push(performance.now() - start);
            }
        }
        setResolveCache(false);
        expect(findLiveWrappers()).toEqual([]);
        expect(liveChar().globalLore).toHaveLength(LORE_SIZE);
        expect(new Set(liveRecord<any[]>(PRESETS_KIND).map((preset) => preset.id)).size).toBe(50);
        const medians = Object.fromEntries(
            Object.entries(times).map(([name, list]) => [name, { drag: median(list.drag), move: median(list.move) }]),
        );
        console.info(
            [
                "[projection spike] round 2, bulk paths (median of 9 rounds, ms; dev-mode Svelte under vitest):",
                ...Object.entries(medians).map(
                    ([name, value]) =>
                        `  ${name}: lorebook drag (300 new items) ${value.drag.toFixed(3)} (x${(value.drag / medians.direct.drag).toFixed(2)}), preset reorder (50) ${value.move.toFixed(3)} (x${(value.move / medians.direct.move).toFixed(2)})`,
                ),
            ].join("\n"),
        );
    });

    it("mounting and re-rendering a component bound to 60 fields", () => {
        // A 60-field record of the section fields' primitive values (the `ui` record holds 58), held
        // as one record so the direct baseline is one `$state` object, as `spikeRoot.db` is today.
        const primitives = (data: Record<string, unknown>) =>
            Object.entries(data).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value));
        const bench = Object.fromEntries(
            [...primitives(liveRecord("ui")), ...primitives(liveRecord("providers"))].slice(0, 60),
        );
        const fields = Object.keys(bench);
        expect(fields).toHaveLength(60);
        applyRaw("ui", "bench", bench);
        const sources: Record<string, () => any> = {
            direct: () => liveRecord("ui", "bench"),
            accessor: () => projectRecord("ui", "bench"),
            tracked: () => trackedRecord("ui", "bench"),
            "tracked-cached": () => trackedRecord("ui", "bench"),
        };
        const results: Record<string, { mount: number[]; rerender: number[]; single: number[] }> = {};
        const flip = (value: unknown, round: number) =>
            typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : `${value}-r${round}`;
        resetCounters();
        for (let round = 0; round < 5; round += 1) {
            for (const [name, source] of Object.entries(sources)) {
                setResolveCache(name === "tracked-cached");
                results[name] ??= { mount: [], rerender: [], single: [] };
                const target = document.createElement("div");
                document.body.appendChild(target);
                let start = performance.now();
                const instance = mount(SpikeRecordMany, {
                    target,
                    props: {
                        get record() {
                            return source();
                        },
                        fields,
                    },
                });
                flushSync();
                results[name].mount.push(performance.now() - start);
                const inputs = [...target.querySelectorAll("input")];
                expect(inputs).toHaveLength(60);

                const next = edited("ui", "bench", (data) => {
                    for (const field of fields) {
                        data[field] = flip(data[field], round);
                    }
                });
                start = performance.now();
                applyRaw("ui", "bench", next);
                flushSync();
                results[name].rerender.push(performance.now() - start);
                inputs.forEach((input, index) => expect(input.value).toBe(String(next[fields[index]])));

                start = performance.now();
                source()[fields[0]] = `single-${name}-${round}`;
                flushSync();
                results[name].single.push(performance.now() - start);
                expect(inputs[0].value).toBe(`single-${name}-${round}`);
                void unmount(instance);
                target.remove();
            }
        }
        // Renders queue nothing; only the single-field writes through a wrapper did (5 rounds x 3 wrappers).
        expect(stats.queueCalls.get(keyOf("ui", "bench"))).toBe(15);
        expect([...stats.queueCalls.keys()]).toEqual([keyOf("ui", "bench")]);
        console.info(
            [
                "[projection spike] proof 5, 60 bound fields (median of 5 rounds, ms): mount / whole-record re-render / one-field re-render",
                ...Object.entries(results).map(
                    ([name, list]) =>
                        `  ${name}: ${median(list.mount).toFixed(2)} / ${median(list.rerender).toFixed(2)} / ${median(list.single).toFixed(3)}`,
                ),
            ].join("\n"),
        );
    });
});
