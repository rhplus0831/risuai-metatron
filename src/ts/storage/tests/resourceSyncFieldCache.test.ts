import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../../shared/characters.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";

// The save loop's character field-text cache (`characterProjection`, `characterTexts`, and
// `canonicalShape` in `resourceSync.svelte.ts`; `docs/structure/persistence.md` save step 2) under the
// real boot, the real save loop, and the fake resource server. The oracle is twofold: the server's
// record must equal the mirror's after every save, and the development comparison of the cached text
// with a whole serialization (`console.error`, reported, never repaired) must not fire once, so
// `console.error` is spied on and never mocked away here. Covered: an unchanged large field is not
// serialized again after a small edit while a write under it is; every write path (set at depth,
// delete, defineProperty, each array mutator, `replaceRecordList`, `moveRecordListItem`, batched
// writes, same-field reuse, a copy from another character); the raw paths (`applyRawCharacter`,
// `patchRawCharacter` with the same identity, a same-id replacement, a deletion and re-creation); the
// cache bound (the oldest of nine characters is serialized again); the challenge's end-to-end
// reproductions (Sol, 2026-10-15: a comparator alias, `reloadKeys` and symbol properties holding record
// state, the character's own `toJSON` hook); and `canonicalShape` against `normalizeCharacter` on a
// whole parse, over fixed and pseudo-random shapes.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertTerminal: alerts.terminal,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const LOCAL = new Set(["chats", "chatPage", "reloadKeys"]);
const DEV_REPORT = /field-text cache differs/;
const character = (chaId: string, name: string, extra: Record<string, unknown> = {}) => ({
    chaId,
    name,
    type: "character",
    ...extra,
});
/** A large array field: `count` entries of about 60 UTF-16 units each. */
const big = (count: number) => Array.from({ length: count }, (_, i) => ({ i, text: `entry ${i} ${"x".repeat(40)}` }));

async function boot(prepare: (fake: FakeResourceServer) => void = () => {}) {
    vi.resetModules();
    const fake = new FakeResourceServer();
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", character("a", "Alice"));
    fake.set("characters", "b", character("b", "Bob"));
    prepare(fake);
    await materialize(fake);
    server.current = fake;
    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const bootstrap = await import("../../bootstrap");
    const characterStore = await import("../characterStore.svelte");
    const selection = await import("../selection.svelte");
    const records = await import("../records.svelte");
    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    // Spied, not mocked away: the development comparison reports a cache miss here, and the tests
    // assert it never fires.
    const errors = vi.spyOn(console, "error");
    const stringify = vi.spyOn(JSON, "stringify");

    const flush = async () => {
        await tick();
        await sync.flushResources();
    };
    const c = (id: string) => characterStore.characterList().find((entry: any) => entry?.chaId === id) as any;
    const rawOf = (id: string) => records.characterData().find((entry) => entry?.chaId === id) as any;
    const ops = () => fake.batchBodies().flatMap((batch) => batch.ops ?? []);
    const reports = () => errors.mock.calls.filter((call) => DEV_REPORT.test(String(call[0]))).length;
    /** How often `JSON.stringify` was called with exactly this value (a field serialized on its own). */
    const serialized = (value: unknown) => stringify.mock.calls.filter((call) => call[0] === value).length;
    /** The mirror's character as the save loop projects it (own fields, no local fields). */
    const projected = (id: string) =>
        Object.fromEntries(Object.entries(plain(c(id))).filter(([key]) => !LOCAL.has(key)));
    /** Server and mirror hold the same character, and the development comparison never fired. */
    const agree = (id: string) => {
        expect(fake.data("characters", id), `${id}: server equals mirror`).toEqual(projected(id));
        expect(reports(), "DEV cache reports").toBe(0);
    };
    return { fake, sync, records, characterStore, c, rawOf, flush, ops, reports, serialized, agree };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("cache reuse", () => {
    it("does not serialize an unchanged large field again after a small edit, and does after a write under it", async () => {
        const { fake, c, rawOf, flush, ops, serialized, agree } = await boot();
        c("a").assets = big(3000);
        await flush();
        const assets = rawOf("a").assets;
        expect(serialized(assets)).toBe(1);
        agree("a");
        fake.requests.length = 0;

        c("a").name = "edited";
        await flush();
        expect(serialized(assets)).toBe(1);
        expect(ops()).toHaveLength(1);
        expect(ops()[0].patch).toEqual({ set: { name: "edited" }, remove: [] });
        agree("a");
        fake.requests.length = 0;

        c("a").assets[1234].text = "changed in place";
        await flush();
        expect(serialized(assets)).toBe(2);
        expect(Object.keys(ops()[0].patch.set)).toEqual(["assets"]);
        expect(fake.data("characters", "a").assets[1234].text).toBe("changed in place");
        agree("a");

        // Two edits in one cycle: each field once, the large one not at all.
        fake.requests.length = 0;
        c("a").name = "again";
        c("a").desc = "a description";
        await flush();
        expect(serialized(assets)).toBe(2);
        expect(ops()[0].patch).toEqual({ set: { name: "again", desc: "a description" }, remove: [] });
        agree("a");
    });

    it("serializes the oldest of nine cached characters again (the cache holds eight)", async () => {
        const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
        const { c, rawOf, flush, serialized, agree } = await boot((fake) => {
            for (const id of ids) {
                fake.set("characters", id, character(id, id.toUpperCase(), { assets: big(200) }));
            }
        });
        for (const id of ids) {
            c(id).name = `${id} edited`;
        }
        await flush();
        const assets = Object.fromEntries(ids.map((id) => [id, rawOf(id).assets]));
        for (const id of ids) {
            expect(serialized(assets[id]), id).toBe(1);
            agree(id);
        }
        // `a` was projected first, so it is the oldest and was dropped when `i` was remembered;
        // `i` is the newest. (Editing every character again would evict one per miss in turn.)
        c("a").name = "a again";
        c("i").name = "i again";
        await flush();
        expect(serialized(assets.a)).toBe(2);
        for (const id of ids.slice(1)) {
            expect(serialized(assets[id]), id).toBe(1);
        }
        agree("a");
        agree("i");
    });
});

describe("every write path saves the mirror's text", () => {
    it("set at depth, delete, defineProperty, each mutator, replaceRecordList, moveRecordListItem, batched writes, same-field reuse", async () => {
        const { c, records, flush, agree } = await boot();
        const a = c("a");
        const step = async (write: () => void) => {
            write();
            await flush();
            agree("a");
            agree("b");
        };
        await step(() => {
            a.rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
            a.lore = { entries: [{ x: 1 }], k: 1 };
            a.assets = big(50);
        });
        await step(() => (a.lore.entries[0].x = 2));
        await step(() => delete a.lore.k);
        await step(() => delete a.lore);
        await step(() =>
            Object.defineProperty(a, "defined", {
                value: [{ d: 1 }],
                writable: true,
                enumerable: true,
                configurable: true,
            }),
        );
        await step(() => (a.defined[0].d = 2));
        await step(() => a.rows.push({ n: 4 }, { n: 5 }));
        await step(() => a.rows.pop());
        await step(() => a.rows.unshift({ n: 0 }));
        await step(() => a.rows.shift());
        await step(() => a.rows.splice(1, 1, { n: 9 }, { n: 8 }));
        await step(() => a.rows.sort((x: any, y: any) => x.n - y.n));
        await step(() => a.rows.reverse());
        await step(() => a.rows.copyWithin(0, 2, 3));
        await step(() => a.rows.fill({ n: 7 }, 3));
        await step(() => (a.rows.length = 2));
        await step(() => records.replaceRecordList(a.rows, [a.rows[1], a.rows[0], { n: 11 }]));
        await step(() => records.moveRecordListItem(a.rows, 0, 2));
        await step(() =>
            records.batchRecordWrites(() => {
                a.name = "batched";
                a.rows[0].n = 100;
                a.assets[10].text = "batched too";
            }),
        );
        await step(() => {
            a.rows.push(a.rows[0]);
            a.rows.splice(0, 1, a.rows[1]);
            a.rows = [...a.rows].reverse();
        });
        await step(() => (a.assets = a.assets.filter((_: unknown, index: number) => index % 2 === 0)));
        // A copy from another character, then a write to the copy only.
        await step(() => (c("b").rows = a.rows));
        await step(() => (c("b").rows[0].n = -1));
        // The caller's object is not linked: a later write to it changes nothing and is saved nowhere.
        const input = { n: 1 };
        await step(() => (a.payload = input));
        input.n = 2;
        await step(() => (a.name = "after the input changed"));
        expect(a.payload.n).toBe(1);
    });

    it("the raw paths: fresh data, a same-identity patch, a same-id replacement, a deletion and re-creation", async () => {
        const { fake, c, rawOf, records, flush, serialized, agree } = await boot();
        const a = c("a");
        a.assets = big(300);
        a.rows = [{ n: 1 }];
        await flush();
        agree("a");

        // A server copy written raw (a conflict reload, a hydration): nothing marked, the next edit
        // serializes everything afresh and saves the server's values.
        records.applyRawCharacter("a", {
            ...plain(fake.data("characters", "a")),
            name: "from the server",
            rows: [{ n: 2 }],
        });
        a.desc = "edited after the reload";
        await flush();
        expect(fake.data("characters", "a")).toMatchObject({
            name: "from the server",
            rows: [{ n: 2 }],
            desc: "edited after the reload",
        });
        agree("a");

        // A raw patch of a field keeping the value's identity (changed in place): stamped anyway.
        const rows = rawOf("a").rows;
        rows[0].n = 3;
        records.patchRawCharacter("a", [["rows", rows]]);
        a.name = "after the raw patch";
        await flush();
        expect(fake.data("characters", "a").rows).toEqual([{ n: 3 }]);
        agree("a");

        // A same-id replacement keeping a field by its wrapper: that field's text is reused, the rest is new.
        const assets = rawOf("a").assets;
        const before = serialized(assets);
        records.replaceCharacterRecordAt(0, {
            chaId: "a",
            name: "replaced",
            type: "character",
            assets: a.assets,
            rows: [{ n: 4 }],
        });
        await flush();
        expect(serialized(assets)).toBe(before);
        expect(fake.data("characters", "a")).toEqual(
            plain(
                normalizeCharacter({
                    chaId: "a",
                    name: "replaced",
                    type: "character",
                    assets: big(300),
                    rows: [{ n: 4 }],
                }),
            ),
        );
        agree("a");

        // Deleted and created again with the same id: a new record with its own text.
        records.removeCharacterRecords(["a"]);
        await flush();
        expect(fake.data("characters", "a")).toBeNull();
        records.insertCharacterRecord({ chaId: "a", name: "created again", type: "character", assets: big(5) });
        await flush();
        expect(fake.data("characters", "a")).toEqual(
            plain(normalizeCharacter({ chaId: "a", name: "created again", type: "character", assets: big(5) })),
        );
        agree("a");
    });
});

describe("the challenge's reproductions, end to end", () => {
    it("a sort comparator writing a raw owned object into another field: the character is saved whole and right (point 1)", async () => {
        const { fake, c, rawOf, flush, agree } = await boot();
        c("a").left = { n: 1 };
        c("a").rows = [2, 1];
        await flush();
        const rawLeft = rawOf("a").left;
        void c("a").left;
        c("a").rows.sort((x: number, y: number) => {
            c("a").right = rawLeft;
            return x - y;
        });
        await flush();
        expect(fake.data("characters", "a")).toMatchObject({ rows: [1, 2], right: { n: 1 } });
        c("a").left.n = 9;
        await flush();
        expect(fake.data("characters", "a")).toMatchObject({ left: { n: 9 }, right: { n: 9 } });
        agree("a");
    });

    it("reloadKeys given record state holds a detached copy: a write through it changes nothing persisted (point 2)", async () => {
        const { fake, c, rawOf, flush, agree } = await boot();
        c("a").payload = { n: 1 };
        await flush();
        void c("a").payload;
        c("a").reloadKeys = { nested: rawOf("a").payload };
        c("a").reloadKeys.nested.n = 7;
        c("b").reloadKeys = { nested: rawOf("a").payload };
        c("b").reloadKeys.nested.n = 8;
        c("a").name = "dirty";
        await flush();
        expect(rawOf("a").payload).toEqual({ n: 1 });
        expect(fake.data("characters", "a")).toMatchObject({ name: "dirty", payload: { n: 1 } });
        agree("a");
    });

    it("a symbol property given the character's own state: the write through it is saved (point 3)", async () => {
        const { fake, c, rawOf, flush, agree } = await boot();
        c("a").payload = { n: 1 };
        await flush();
        void c("a").payload;
        const key = Symbol("alias");
        c("a")[key] = rawOf("a").payload;
        c("a")[key].n = 6;
        c("a").name = "dirty";
        await flush();
        expect(fake.data("characters", "a")).toMatchObject({ name: "dirty", payload: { n: 6 } });
        agree("a");
    });

    it("a character's own toJSON hook is invoked and the record sent whole, without a patch (point 4)", async () => {
        const { fake, c, records, flush, ops, reports } = await boot();
        c("a").assets = big(20);
        await flush();
        fake.requests.length = 0;
        records.applyRawCharacter("a", {
            ...plain(fake.data("characters", "a")),
            toJSON: () => ({ chaId: "a", name: "hooked", type: "character" }),
        });
        c("a").name = "ordinary";
        await flush();
        const [sent] = ops();
        expect(sent).toMatchObject({
            kind: "characters",
            id: "a",
            data: { chaId: "a", name: "hooked", type: "character" },
        });
        expect(sent).not.toHaveProperty("patch");
        expect(fake.data("characters", "a")).toEqual({ chaId: "a", name: "hooked", type: "character" });
        expect(reports()).toBe(0);
    });
});

describe("canonicalShape against normalizeCharacter on a whole parse", () => {
    /** A small deterministic generator (an LCG) for the pseudo-random shapes. */
    function lcg(seed: number) {
        let state = seed >>> 0;
        return () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 2 ** 32;
        };
    }
    const pick = <T>(random: () => number, options: readonly T[]) => options[Math.floor(random() * options.length)]!;
    const defaultFields = Object.keys(normalizeCharacter({ chaId: "x", type: "character" })).filter(
        (field) => !["chaId", "type"].includes(field),
    );
    const groupFields = Object.keys(normalizeCharacter({ chaId: "x", type: "group", characters: ["p", "q"] })).filter(
        (field) => !["chaId", "type"].includes(field),
    );

    /** A raw character shape: each default field absent, null, NaN (null in JSON), a stand-in value, or the string "null". */
    function shape(random: () => number, id: string): Record<string, unknown> {
        const isGroup = random() < 0.4;
        const out: Record<string, unknown> = { chaId: id, name: `N${id}`, type: isGroup ? "group" : "character" };
        for (const field of isGroup ? groupFields : defaultFields) {
            const choice = pick(random, [
                "absent",
                "null",
                "nan",
                "undefined",
                "value",
                "string-null",
                "zero",
                "false",
            ]);
            if (choice === "absent") continue;
            out[field] =
                choice === "null"
                    ? null
                    : choice === "nan"
                      ? NaN
                      : choice === "undefined"
                        ? undefined
                        : choice === "string-null"
                          ? "null"
                          : choice === "zero"
                            ? 0
                            : choice === "false"
                              ? false
                              : { v: [1, { w: "x" }] };
        }
        if (isGroup) {
            const size = Math.floor(random() * 4);
            out.characters = Array.from({ length: size }, (_, i) => `m${i}`);
            const talks = pick(random, ["absent", "null", "fit", "short", "long"]);
            if (talks !== "absent") {
                out.characterTalks =
                    talks === "null"
                        ? null
                        : Array.from(
                              { length: talks === "fit" ? size : talks === "short" ? Math.max(0, size - 1) : size + 1 },
                              () => 0.5,
                          );
            }
            const active = pick(random, ["absent", "null", "fit", "wrong"]);
            if (active !== "absent") {
                out.characterActive =
                    active === "null" ? null : Array.from({ length: active === "fit" ? size : size + 2 }, () => true);
            }
        }
        for (const screen of ["viewScreen", "inlayViewScreen"]) {
            const choice = pick(random, ["absent", "null", "none", "emotion", "imggen", "vn", "value"]);
            if (choice !== "absent") {
                out[screen] = choice === "null" ? null : choice === "value" ? 1 : choice;
            }
        }
        return out;
    }

    it('fixed shapes: missing and null defaults, NaN and undefined values, the string "null", an own __proto__ key, a group\'s companion arrays, a refused group', async () => {
        const fixed: Record<string, Record<string, unknown>> = {
            f1: { chaId: "f1", name: "bare" },
            f2: {
                chaId: "f2",
                name: "nulls",
                type: null,
                desc: null,
                globalLore: null,
                viewScreen: null,
                lastInteraction: null,
            },
            f3: {
                chaId: "f3",
                name: "nan",
                type: "character",
                firstMsgIndex: NaN,
                lastInteraction: Infinity,
                tags: undefined,
            },
            f4: { chaId: "f4", name: "strings", type: "character", desc: "null", viewScreen: "null", personality: "" },
            f5: JSON.parse('{"chaId":"f5","name":"proto","type":"character","__proto__":{"k":1},"customscript":null}'),
            f6: {
                chaId: "f6",
                name: "group fit",
                type: "group",
                characters: ["p", "q"],
                characterTalks: [1, 1],
                characterActive: [true, false],
            },
            f7: {
                chaId: "f7",
                name: "group short",
                type: "group",
                characters: ["p", "q", "r"],
                characterTalks: [1],
                characterActive: null,
            },
            f8: {
                chaId: "f8",
                name: "group screens",
                type: "group",
                characters: [],
                viewScreen: "emotion",
                inlayViewScreen: 1,
            },
            f9: {
                chaId: "f9",
                name: "nested ints",
                type: "character",
                bias: [["a", 1]],
                additionalData: { "10": 1, "2": 2, x: { "7": 1, "3": 2 } },
            },
        };
        const { fake, c, records, flush, agree, reports } = await boot((server) => {
            for (const id of Object.keys(fixed)) {
                server.set("characters", id, character(id, id));
            }
            server.set("characters", "refused", character("refused", "refused"));
        });
        const expected: Record<string, unknown> = {};
        for (const [id, raw] of Object.entries(fixed)) {
            records.applyRawCharacter(id, raw);
            c(id).name = `${id} edited`;
            expected[id] = plain(normalizeCharacter(plain({ ...raw, name: `${id} edited` })));
        }
        // A group whose `characters` is not a list: the helper refuses it and the record goes as it is.
        records.applyRawCharacter("refused", { chaId: "refused", name: "r", type: "group", characters: "p" });
        c("refused").name = "refused edited";
        await flush();
        for (const id of Object.keys(fixed)) {
            expect(fake.data("characters", id), id).toEqual(expected[id]);
            agree(id);
        }
        expect(Object.getOwnPropertyDescriptor(fake.data("characters", "f5"), "__proto__")!.value).toEqual({ k: 1 });
        expect(fake.data("characters", "refused")).toEqual({
            chaId: "refused",
            name: "refused edited",
            type: "group",
            characters: "p",
        });
        expect(reports()).toBe(0);
    });

    it("120 pseudo-random shapes agree with the whole-parse normalization", async () => {
        const random = lcg(20261015);
        const ids = Array.from({ length: 120 }, (_, i) => `r${i}`);
        const { fake, c, records, flush, agree, reports } = await boot((server) => {
            for (const id of ids) {
                server.set("characters", id, character(id, id));
            }
        });
        const expected: Record<string, unknown> = {};
        for (const id of ids) {
            const raw = shape(random, id);
            records.applyRawCharacter(id, raw);
            c(id).name = `${id} edited`;
            expected[id] = plain(normalizeCharacter(plain({ ...raw, name: `${id} edited` })));
        }
        await flush();
        for (const id of ids) {
            expect(fake.data("characters", id), id).toEqual(expected[id]);
            agree(id);
        }
        expect(reports()).toBe(0);
    }, 20_000);
});
