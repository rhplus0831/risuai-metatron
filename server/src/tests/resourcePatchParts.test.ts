import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";

// A patch op of a `shallowNormalize` kind (`characters`, `modules`) serializes only what changed
// (`writePatch`'s fast path: `cutRecord`, `patchParts`, `storedParts`, `canonicalPart`, the `patchBases`
// cache). Each test runs the same writes on a store of the real kinds and on one whose kinds have the
// flag stripped (the whole-record path) and requires the same stored text, the same errors, and the same
// feed patches; plus the cache's invalidation (a whole write, a rolled-back batch), the feed's copy, and
// that a patch of a cached record parses and stringifies nothing of its size.

const FAST = createKindRegistry(DEFAULT_RESOURCE_KINDS);
/** `JSON.rawJSON` (Node 21+), which the server's lib types leave out. */
const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;
const SLOW = createKindRegistry(DEFAULT_RESOURCE_KINDS.map((kind) => ({ ...kind, shallowNormalize: undefined })));
const CHARACTER_ID = "c";
const MODULES_ID = "main";

type Side = {
    store: ResourceStore;
    characters: ResourceKind;
    modules: ResourceKind;
    events: ChangeFeedEvent[];
    text(kind: ResourceKind, id: string): string;
};

const dirs: string[] = [];
const stores: ResourceStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A store on a file, so the stored text itself can be read back (`text`). */
function side(kinds: typeof FAST): Side {
    const dir = mkdtempSync(path.join(tmpdir(), "patch-parts-"));
    dirs.push(dir);
    const file = path.join(dir, "resources.sqlite");
    const feed = createChangeFeed();
    const events: ChangeFeedEvent[] = [];
    feed.subscribe((event) => events.push(event));
    const store = createResourceStore({ file, kinds, feed });
    stores.push(store);
    const reader = new DatabaseSync(file, { readOnly: true });
    const select = reader.prepare("SELECT data FROM resources WHERE kind = ? AND id = ?");
    return {
        store,
        characters: kinds.get("characters")!,
        modules: kinds.get("modules")!,
        events,
        text: (kind, id) => (select.get(kind.name, id) as { data: string }).data,
    };
}

/** Both sides, seeded with the same character and module list. */
function pair(character: Record<string, unknown>, modules: unknown[]): [Side, Side] {
    const sides: [Side, Side] = [side(SLOW), side(FAST)];
    for (const s of sides) {
        s.store.put(s.characters, CHARACTER_ID, character, null);
        s.store.put(s.modules, MODULES_ID, modules, null);
    }
    return sides;
}

function patchOn(s: Side, kind: "characters" | "modules", patch: unknown): string {
    const k = s[kind];
    const id = kind === "characters" ? CHARACTER_ID : MODULES_ID;
    try {
        s.store.applyBatch([{ kind: k, id, baseRevision: s.store.revisionOf(k, id), patch }]);
        return s.text(k, id);
    } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
    }
}

/** The feed patches published since `from`, as JSON, without their base revisions (each store has its own epoch). */
function feedPatches(s: Side, from: number): string {
    return JSON.stringify(
        s.events
            .slice(from)
            .flatMap((event) =>
                event.type === "change"
                    ? event.changes.resources.map((ref) => (ref.patch ? { ...ref.patch, baseRevision: null } : null))
                    : [],
            ),
    );
}

/** Runs one patch on both sides and requires the same outcome, stored text, and feed patch. */
function same(sides: [Side, Side], kind: "characters" | "modules", make: () => unknown) {
    const before = sides.map((s) => s.events.length);
    const outcomes = sides.map((s) => patchOn(s, kind, make()));
    expect(outcomes[1]).toBe(outcomes[0]);
    expect(feedPatches(sides[1], before[1])).toBe(feedPatches(sides[0], before[0]));
    return outcomes[1];
}

function seeded(seed: number) {
    let state = seed;
    return (n: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % n;
    };
}

const VALUES: (() => unknown)[] = [
    () => undefined,
    () => null,
    () => false,
    () => 0,
    () => -0,
    () => 42,
    () => "x",
    () => [],
    () => ({}),
    () => [1, { x: [2] }],
    () => ({ toJSON: "plain" }),
    () => JSON.parse('{"__proto__":{"x":1}}'),
    () => rawJSON("1e2"),
    () => ({ n: rawJSON("-0") }),
    () => new Number(3),
    () => ({ toJSON: (key: string) => `key:${key}` }),
];

describe("a patch of a shallowNormalize kind", () => {
    it("stores what the whole-record path stores, for field patches of a character", () => {
        const rand = seeded(7);
        const fields = ["name", "desc", "tags", "newGenData", "type", "characters", "lastInteraction", "a", "0", "10"];
        for (const start of [
            { chaId: CHARACTER_ID, name: "C" },
            JSON.parse('{"chaId":"c","__proto__":{"x":1},"1":2,"z":[1]}'),
            { chaId: CHARACTER_ID, type: "group", characters: ["a", "b"] },
        ]) {
            const sides = pair(start, []);
            for (let step = 0; step < 300; step++) {
                const field = fields[rand(fields.length)];
                const value = VALUES[rand(VALUES.length)];
                const remove = rand(5) === 0;
                same(sides, "characters", () =>
                    remove ? { remove: [field] } : { set: { [field]: value(), lastInteraction: step } },
                );
            }
        }
    });

    it("stores what the whole-record path stores, for item patches of the module list", () => {
        const rand = seeded(11);
        const sides = pair({ chaId: CHARACTER_ID }, [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
        ]);
        for (let step = 0; step < 300; step++) {
            const id = ["a", "b", "c"][rand(3)];
            const value = VALUES[rand(VALUES.length)];
            const kindOfPatch = rand(4);
            const order = [["a", "b"], ["b", "a"], ["a"], ["a", "b", "c"]][rand(4)];
            same(sides, "modules", () => {
                if (kindOfPatch === 0) {
                    return { order };
                }
                if (kindOfPatch === 1) {
                    return { items: [{ id, name: "N", extra: value() }], order: ["a", "b", "c"] };
                }
                return { changes: [{ id, set: { extra: value() } }] };
            });
        }
    });

    it("refuses as the whole-record path refuses, in the same order", () => {
        const sides = pair({ chaId: CHARACTER_ID, a: 0, b: 0 }, [{ id: "a" }]);
        let deep: unknown = {};
        for (let i = 0; i < 256; i++) {
            deep = [deep];
        }
        const refusals = [
            () => ({ set: { b: Infinity, a: 1n } }),
            () => ({ set: { a: deep, b: JSON.parse("1e400") } }),
            () => ({ set: { chaId: "other" } }),
            () => ({ set: { chats: [] } }),
            () => ({ set: { type: "group", characters: "x" } }),
        ];
        for (const make of refusals) {
            expect(same(sides, "characters", make)).toMatch(/^ResourceValidationError: ops\[0\]: /);
        }
        expect(same(sides, "modules", () => ({ changes: [{ id: "a", set: { name: 1 } }] }))).toMatch(
            /^ResourceValidationError: ops\[0\]: modules\[0\]/,
        );
        // Hooks run in the record's order, with their own keys, as in one whole serialization.
        same(sides, "characters", () => {
            let calls = 0;
            return { set: { b: { toJSON: () => ++calls }, a: { toJSON: () => ++calls } } };
        });
        same(sides, "modules", () => ({
            items: [{ id: "b", toJSON: (key: string) => ({ id: "b", name: key }) }],
            order: ["a", "b"],
        }));
        expect(JSON.parse(sides[1].text(sides[1].modules, MODULES_ID))[1]).toEqual({ id: "b", name: "1" });
    });

    it("keeps no value the stored text does not hold, across successive patches", () => {
        const sides = pair({ chaId: CHARACTER_ID }, [{ id: "a" }]);
        same(sides, "modules", () => ({ changes: [{ id: "a", set: { extra: rawJSON("-0") } }] }));
        same(sides, "modules", () => ({
            changes: [
                {
                    id: "a",
                    set: {
                        toJSON(this: { extra: number }) {
                            return { id: "a", sign: Object.is(this.extra, -0) ? "minus" : "plus" };
                        },
                    },
                },
            ],
        }));
        expect(JSON.parse(sides[1].text(sides[1].modules, MODULES_ID))).toEqual([{ id: "a", sign: "plus" }]);
    });

    it("reads the stored record again after a whole write or a rolled-back batch", () => {
        const sides = pair({ chaId: CHARACTER_ID, name: "C", desc: "one" }, [{ id: "a" }]);
        same(sides, "characters", () => ({ set: { desc: "two" } }));
        for (const s of sides) {
            s.store.put(
                s.characters,
                CHARACTER_ID,
                { chaId: CHARACTER_ID, name: "W" },
                s.store.revisionOf(s.characters, CHARACTER_ID),
            );
        }
        same(sides, "characters", () => ({ set: { desc: "three" } }));
        expect(JSON.parse(sides[1].text(sides[1].characters, CHARACTER_ID))).toMatchObject({
            name: "W",
            desc: "three",
        });
        // The character patch is applied (and cached) before the module patch fails the batch.
        for (const s of sides) {
            expect(() =>
                s.store.applyBatch([
                    {
                        kind: s.characters,
                        id: CHARACTER_ID,
                        baseRevision: s.store.revisionOf(s.characters, CHARACTER_ID),
                        patch: { set: { desc: "rolled back" } },
                    },
                    {
                        kind: s.modules,
                        id: MODULES_ID,
                        baseRevision: s.store.revisionOf(s.modules, MODULES_ID),
                        patch: { changes: [{ id: "missing", set: { name: "x" } }] },
                    },
                ]),
            ).toThrow(/ops\[1\]/);
        }
        same(sides, "characters", () => ({ set: { name: "after" } }));
        expect(JSON.parse(sides[1].text(sides[1].characters, CHARACTER_ID))).toMatchObject({
            name: "after",
            desc: "three",
        });
    });

    it("gives the feed a copy, so a listener cannot change the next patch's result", () => {
        const s = side(FAST);
        s.store.put(s.modules, MODULES_ID, [{ id: "a" }], null);
        const from = s.events.length;
        patchOn(s, "modules", { changes: [{ id: "a", set: { extra: { n: 1 } } }] });
        const event = s.events[from] as Extract<ChangeFeedEvent, { type: "change" }>;
        const patch = event.changes.resources[0].patch as unknown as { changes: { set: { extra: { n: number } } }[] };
        patch.changes[0].set.extra.n = 999;
        patchOn(s, "modules", { changes: [{ id: "a", set: { name: "renamed" } }] });
        expect(JSON.parse(s.text(s.modules, MODULES_ID))).toEqual([{ id: "a", extra: { n: 1 }, name: "renamed" }]);
    });

    it("parses nothing of the record's size for a patch of a cached record", () => {
        const s = side(FAST);
        const assets = Array.from({ length: 20000 }, (_, index) => [`asset ${index}`, `assets/${index}.png`, "png"]);
        s.store.put(s.characters, CHARACTER_ID, { chaId: CHARACTER_ID, additionalAssets: assets }, null);
        const size = s.text(s.characters, CHARACTER_ID).length;
        const parse = vi.spyOn(JSON, "parse");
        const stringify = vi.spyOn(JSON, "stringify");
        try {
            patchOn(s, "characters", { set: { desc: "first" } });
            parse.mockClear();
            stringify.mockClear();
            patchOn(s, "characters", { set: { desc: "second" } });
            expect(parse.mock.calls.filter(([text]) => String(text).length >= size / 2)).toHaveLength(0);
            expect(stringify.mock.results.filter((result) => String(result.value).length >= size / 2)).toHaveLength(0);
        } finally {
            parse.mockRestore();
            stringify.mockRestore();
        }
        expect(JSON.parse(s.text(s.characters, CHARACTER_ID)).desc).toBe("second");
    });
});

// Slice 3g: observe both the stored result and its feed, including the work avoided by the fast path.
describe("general record patch writes", () => {
    it("patches pluginStorage without parsing or serializing its unchanged payload, and publishes a detached field diff", () => {
        const s = side(FAST);
        const kind = FAST.get("pluginStorage")!;
        const keep = { nested: "가".repeat(100_000) };
        s.store.put(kind, "main", { keep, obsolete: true, value: 1 }, null);
        const write = (patch: unknown) =>
            s.store.applyChanges({
                ops: [{ kind, id: "main", baseRevision: s.store.revisionOf(kind, "main"), patch }],
            });
        write({ set: { value: 2 } });
        const baseRevision = s.store.revisionOf(kind, "main");
        const parse = vi.spyOn(JSON, "parse");
        const stringify = vi.spyOn(JSON, "stringify");
        try {
            write({ set: { value: 3 }, remove: ["obsolete"] });
            expect(parse.mock.calls.some(([text]) => String(text).includes(keep.nested))).toBe(false);
            expect(
                stringify.mock.results.some(({ value }) => typeof value === "string" && value.includes(keep.nested)),
            ).toBe(false);
        } finally {
            parse.mockRestore();
            stringify.mockRestore();
        }
        expect(s.store.get(kind, "main")!.data).toEqual({ keep, value: 3 });
        const event = s.events.at(-1)!;
        expect(event.type).toBe("change");
        if (event.type !== "change") throw new Error("missing feed change");
        expect(event.changes.resources[0].patch).toEqual({ baseRevision, set: { value: 3 }, remove: ["obsolete"] });
    });

    it("diffs slow-path stored preset text into changed items and order without reserializing unchanged prompts, and caps the feed", () => {
        const s = side(FAST);
        const kind = FAST.get("presets")!;
        const prompt = "unchanged 한글 ".repeat(10_000);
        s.store.put(
            kind,
            "main",
            [
                { id: "a", name: "A", promptTemplate: [{ type: "plain", text: prompt, role: "system" }] },
                { id: "b", name: "B" },
            ],
            s.store.revisionOf(kind, "main"),
        );
        const before = s.store.get(kind, "main")!.data as Record<string, unknown>[];
        const added = { ...before[1], id: "c", name: "C" };
        const baseRevision = s.store.revisionOf(kind, "main");
        const expected = [added, { ...before[0], name: "Renamed" }];
        const whole = side(FAST);
        // A whole write pays for normalization too. A patch must not serialize an unchanged
        // cloned prompt any more times than that control merely to build the feed diff.
        const stringify = vi.spyOn(JSON, "stringify");
        const promptSerializations = () =>
            stringify.mock.calls.filter(([value]) => Array.isArray(value) && value[0]?.text === prompt).length;
        try {
            whole.store.put(kind, "main", expected, whole.store.revisionOf(kind, "main"));
            const normalizationCost = promptSerializations();
            stringify.mockClear();
            s.store.applyChanges({
                ops: [
                    {
                        kind,
                        id: "main",
                        baseRevision,
                        patch: {
                            changes: [{ id: "a", set: { name: "Renamed" } }],
                            items: [added],
                            order: ["c", "a"],
                        },
                    },
                ],
            });
            expect(promptSerializations()).toBeLessThanOrEqual(normalizationCost);
        } finally {
            stringify.mockRestore();
        }
        expect(s.store.get(kind, "main")!.data).toEqual(expected);
        const event = s.events.at(-1)!;
        if (event.type !== "change") throw new Error("missing feed change");
        expect(event.changes.resources[0].patch).toEqual({
            baseRevision,
            items: [added],
            changes: [{ id: "a", set: { name: "Renamed" }, remove: [] }],
            order: ["c", "a"],
        });
        const large = "가".repeat(24_000); // Under 64 Ki characters, over 64 Ki UTF-8 bytes.
        s.store.applyChanges({
            ops: [
                {
                    kind,
                    id: "main",
                    baseRevision: s.store.revisionOf(kind, "main"),
                    patch: { changes: [{ id: "a", set: { mainPrompt: large } }] },
                },
            ],
        });
        const capped = s.events.at(-1)!;
        if (capped.type !== "change") throw new Error("missing feed change");
        expect(capped.changes.resources[0]).not.toHaveProperty("patch");
        expect((s.store.get(kind, "main")!.data as any[])[1].mainPrompt).toBe(large);
    });

    it("uses slow-path field removals and item replacements, omitting an unsafe top-level __proto__ diff", () => {
        // Force the whole normalization path while retaining the production kinds' value contract.
        const s = side(SLOW);
        const plugins = SLOW.get("plugins")!;
        s.store.put(
            plugins,
            "main",
            [{ id: "a", old: 1, keep: { x: [1, 2] } }, JSON.parse('{"id":"b","__proto__":1}')],
            null,
        );
        const baseRevision = s.store.revisionOf(plugins, "main");
        const replacement = JSON.parse('{"id":"b","__proto__":2}');
        s.store.applyChanges({
            ops: [
                {
                    kind: plugins,
                    id: "main",
                    baseRevision,
                    patch: {
                        items: [replacement],
                        changes: [{ id: "a", set: { fresh: false }, remove: ["old"] }],
                    },
                },
            ],
        });
        const event = s.events.at(-1)!;
        if (event.type !== "change") throw new Error("missing feed change");
        expect(event.changes.resources[0].patch).toEqual({
            baseRevision,
            items: [replacement],
            changes: [{ id: "a", set: { fresh: false }, remove: ["old"] }],
        });
        expect(s.store.get(plugins, "main")!.data).toEqual([
            { id: "a", keep: { x: [1, 2] }, fresh: false },
            replacement,
        ]);
        // A slow normalizer can change a top-level reserved key as a side effect of a permitted patch.
        const transformed = {
            ...SLOW.get("pluginStorage")!,
            normalize: (data: any) => ({ ...data, ["__proto__"]: data.version }),
        };
        const registry = createKindRegistry([transformed]);
        const other = side(registry);
        other.store.put(transformed, "main", { version: 1, old: true }, null);
        other.store.applyChanges({
            ops: [
                {
                    kind: transformed,
                    id: "main",
                    baseRevision: other.store.revisionOf(transformed, "main"),
                    patch: { set: { version: 2 }, remove: ["old"] },
                },
            ],
        });
        const unsafe = other.events.at(-1)!;
        if (unsafe.type !== "change") throw new Error("missing feed change");
        expect(unsafe.changes.resources[0]).not.toHaveProperty("patch");
        expect(other.store.get(transformed, "main")!.data).toEqual(JSON.parse('{"version":2,"__proto__":2}'));
    });

    it("charges four units per cut text: evicts older large bases and never caches one over a quarter of the budget", () => {
        const s = side(FAST);
        const kind = s.characters;
        const write = (id: string, value: string) =>
            s.store.applyChanges({
                ops: [{ kind, id, baseRevision: s.store.revisionOf(kind, id), patch: { set: { desc: value } } }],
            });
        const large = "x".repeat(6 * 1024 * 1024);
        for (const id of ["a", "b", "c"]) {
            s.store.put(kind, id, { chaId: id, payload: large }, null);
            write(id, "warm");
        }
        const parsesPayload = (id: string) => {
            const parse = vi.spyOn(JSON, "parse");
            try {
                write(id, "next");
                return parse.mock.calls.some(([text]) => String(text).includes(large));
            } finally {
                parse.mockRestore();
            }
        };
        expect(parsesPayload("b")).toBe(false); // Two 6 Mi texts fit (48 Mi charged units).
        expect(parsesPayload("a")).toBe(true); // Three do not (72 Mi): oldest was evicted.
        s.store.put(kind, "oversized", { chaId: "oversized", payload: "x".repeat(17 * 1024 * 1024) }, null);
        write("oversized", "warm");
        expect(parsesPayload("oversized")).toBe(true);
        expect((s.store.get(kind, "oversized")!.data as any).desc).toBe("next");
    }, 20_000);
});
