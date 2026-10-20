import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { CurrentTriggerIdStore: writable(null), CharEmotion: writable({}) };
});
vi.mock("../../storage/database.svelte", () => ({ appVer: "test", defaultSdDataFunc: () => [] }));
vi.mock("../../globalApi.svelte", () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: vi.fn(async (path: string) => path),
}));
vi.mock("../transformClient", () => ({ captureTransform: () => null, serverProcessScript: vi.fn() }));

import { getDistance, ParseMarkdown, resetAssetsCache, type simpleCharacterArgument } from "../parser.svelte";
import { boundedDistance, findAssetPrefix } from "../assetSearch";
import { selectedCharacter } from "../../storage/characterStore.svelte";
import { isRecordWrapper } from "../../storage/records.svelte";
import { selectCharacter } from "../../storage/selection.svelte";
import { settings } from "../../storage/settingsViews.svelte";
import { installFlatDatabase } from "../../storage/tests/installFlatDatabase";
import { createProbe } from "../../storage/tests/reactiveProbe.svelte";

type Asset = [string, string, string];
const asset = (name: string, path = `assets/${name}.png`): Asset => [name, path, "png"];
function install(assets: Asset[] = [asset("cat")]) {
    installFlatDatabase({
        legacyMediaFindings: false,
        assetMaxDifference: 2,
        enabledModules: ["m"],
        modules: [{ id: "m", name: "Module", description: "", assets: [asset("module")] }],
        characters: [
            { chaId: "c", type: "character", name: "C", additionalAssets: assets, emotionImages: [], customscript: [] },
        ],
    });
    selectCharacter("c");
}
const char = () => selectedCharacter() as import("../../storage/database.svelte").character;
const parse = (name: string, kind = "raw") => ParseMarkdown(`{{${kind}::${name}}}`, char(), "normal", -1, {}, null);
function text(html: string) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent!.trim();
}

beforeEach(() => {
    install();
    flushSync();
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("parser asset inputs", () => {
    it("reads module and character edits at the next parse and in a tracked derived before any flush", async () => {
        const probe = createProbe(() => parse("module", "img"));
        try {
            expect(await probe.derived()).toContain('src="assets/module.png"');
            // A module's asset list is immutable: the edit replaces it whole (heap plan B1).
            settings.modules[0].assets = [asset("module", "assets/module-edited.png")];
            // Calling the derived, then ParseMarkdown, happens in the same stack as the write.
            const tracked = probe.derived();
            const direct = parse("module");
            expect(await tracked).toContain('src="assets/module-edited.png"');
            expect(text(await direct)).toBe("assets/module-edited.png");
            expect(text(await parse("cat"))).toBe("assets/cat.png");
            // A character's asset list is immutable too (heap plan B2): the edit replaces it whole.
            char().additionalAssets = [asset("cat", "assets/character-edited.png")];
            const changed = parse("cat", "img");
            expect(await changed).toContain('src="assets/character-edited.png"');
        } finally {
            probe.dispose();
        }
    });

    it("an explicit three-input reset wins until a live asset input changes", async () => {
        resetAssetsCache([asset("override", "assets/explicit.png")], [["happy", "assets/emotion.png"]], []);
        expect(text(await parse("override"))).toBe("assets/explicit.png");
        expect(await parse("happy", "emotion")).toContain('src="assets/emotion.png"');
        expect(text(await parse("module"))).toBe("");
        flushSync();
        expect(text(await parse("override"))).toBe("assets/explicit.png");
        settings.modules[0].assets = [asset("module", "assets/live.png")];
        const live = parse("module");
        expect(text(await live)).toBe("assets/live.png");
        expect(text(await parse("override"))).toBe("");
    });
});

describe("parser fuzzy assets", () => {
    it("selects the first minimum, normalizes names and preserves threshold comparison semantics", async () => {
        install([
            asset("cut", "assets/first.png"),
            asset("cot", "assets/tie.png"),
            asset("catapult", "assets/far.png"),
            asset("SAD_face.webp", "assets/normalized.png"),
        ]);
        for (const [threshold, expected] of [
            [0, ""],
            [0.9, ""],
            [1, "assets/first.png"],
            [1.9, "assets/first.png"],
            [Infinity, "assets/first.png"],
            [NaN, "assets/first.png"],
            [undefined, "assets/first.png"],
            [-1, ""],
            [-Infinity, ""],
        ] as const) {
            settings.ui.assetMaxDifference = threshold;
            expect(text(await parse("cat")), `threshold ${threshold}`).toBe(expected);
        }
        settings.ui.assetMaxDifference = 0;
        expect(text(await parse("sad face.png"))).toBe("assets/normalized.png");
        // Module assets participate in exact lookup only, never this character-only fuzzy scan.
        settings.ui.assetMaxDifference = 1;
        expect(text(await parse("modulx"))).toBe("");
    });

    it("rescans a cached miss when the threshold grows and a changed fuzzy asset before a flush", async () => {
        settings.ui.assetMaxDifference = 0;
        expect(text(await parse("cot"))).toBe("");
        // Let the parser install its tracked index, then prime a miss on that same index.
        await Promise.resolve();
        flushSync();
        expect(text(await parse("cot"))).toBe("");
        settings.ui.assetMaxDifference = 1;
        expect(text(await parse("cot"))).toBe("assets/cat.png");
        char().additionalAssets = [asset("cat", "assets/fuzzy-edited.png")];
        const edited = parse("cot");
        expect(text(await edited)).toBe("assets/fuzzy-edited.png");
    });

    it("keys the once-built index by a frozen list, never by a retained wrapper of a list that later resolves to one", async () => {
        // A list of another shape (a fourth tuple element that is an object) stays a mutable wrapper
        // (heap plan B2); a simple-character argument built then keeps that wrapper. Once the field
        // holds frozen lists, each replacement must still rebuild the index the wrapper reads
        // (Sol's challenge finding 1, 2026-10-19).
        settings.ui.assetMaxDifference = 1;
        install([["cat", "assets/first.png", "png", { odd: true }] as unknown as Asset]);
        const held = char().additionalAssets;
        expect(isRecordWrapper(held)).toBe(true);
        const simple: simpleCharacterArgument = {
            type: "simple",
            chaId: "c",
            customscript: [],
            additionalAssets: held,
        };
        const lookup = () => ParseMarkdown("{{raw::cot}}", simple, "normal", -1, {}, null);
        expect(text(await lookup())).toBe("assets/first.png");
        for (const [name, path] of [
            ["cut", "assets/second.png"],
            ["cit", "assets/third.png"],
        ]) {
            char().additionalAssets = [asset(name, path)];
            expect(isRecordWrapper(char().additionalAssets)).toBe(false);
            expect(Object.isFrozen(char().additionalAssets)).toBe(true);
            expect(text(await lookup()), path).toBe(path);
            // The same answer through the live frozen list, and again after a flush.
            expect(text(await parse("cot"))).toBe(path);
            flushSync();
            expect(text(await lookup()), `${path} after a flush`).toBe(path);
        }
    });

    it("matches a full scan on deterministic UTF-16 names and lets a later overflow beat distance one", async () => {
        const random = rng(0x3e);
        const alphabet = ["a", "b", "c", "é", "한", "😀", "\ud800", "\udfff"];
        const word = () =>
            Array.from(
                { length: 1 + ((random() >>> 16) % 8) },
                () => alphabet[(random() >>> 16) % alphabet.length],
            ).join("");
        const assets = Array.from({ length: 40 }, (_, i) => asset(word(), `assets/${i}.png`));
        install(assets);
        for (let i = 0; i < 80; i++) {
            const name = word() + "x"; // No direct-map exact hit; exercise the fuzzy public path.
            const threshold = i % 5;
            settings.ui.assetMaxDifference = threshold;
            let best = Infinity;
            let expected = "";
            for (const [candidate, path] of assets) {
                const distance = getDistance(name, candidate);
                if (distance < best) {
                    best = distance;
                    expected = path;
                }
            }
            if (best > threshold) expected = "";
            expect(text(await parse(name)), JSON.stringify({ name, threshold })).toBe(expected);
        }
        install([asset("cut", "assets/near.png"), asset("z".repeat(32768), "assets/overflow.png")]);
        expect(getDistance("cat", "z".repeat(32768))).toBeLessThan(1);
        expect(text(await parse("cat"))).toBe("assets/overflow.png");
    });
});

function rng(seed: number) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
    };
}

describe("bounded asset searches", () => {
    it("equals the UTF-16 full distance inside the cutoff and Infinity outside for random strings", () => {
        const random = rng(0x5eed);
        const alphabet = ["a", "b", "\u0000", "é", "한", "😀", "\ud800", "\udfff"];
        const word = () =>
            Array.from({ length: (random() >>> 16) % 24 }, () => alphabet[(random() >>> 16) % alphabet.length]).join(
                "",
            );
        for (let i = 0; i < 400; i++) {
            const a = word(),
                b = word();
            const distance = getDistance(a, b);
            for (const cutoff of [-1, 0, 1, 3, distance - 1, distance, distance + 0.5, Infinity]) {
                expect(boundedDistance(a, b, cutoff), JSON.stringify({ a, b, cutoff })).toBe(
                    distance <= cutoff ? distance : Infinity,
                );
                expect(boundedDistance(b, a, cutoff)).toBe(distance <= cutoff ? distance : Infinity);
            }
        }
    });

    it("honors the cutoff around and above the legacy Int16 wrap", () => {
        // Keep one dimension short: no quadratic allocation or long-running full scan.
        for (const length of [65537, 32766, 32767, 32768, 32769, 65536]) {
            for (const short of ["", "a", "😀"]) {
                const long = "z".repeat(length);
                for (const [a, b] of [
                    [long, short],
                    [short, long],
                ]) {
                    const distance = getDistance(a, b);
                    for (const cutoff of [distance - 1, distance, 0, 1000, Infinity]) {
                        expect(boundedDistance(a, b, cutoff), JSON.stringify({ length, short, cutoff, distance })).toBe(
                            distance <= cutoff ? distance : Infinity,
                        );
                    }
                }
            }
        }
    });

    it("prefix lookup agrees with strict first-best full scans, including empty paths and the 1000 boundary", () => {
        const fullScan = (name: string, assets: { name: string; path: string }[]) => {
            const dot = name.lastIndexOf(".");
            const prefix = dot > 0 ? name.slice(0, dot) : "";
            let best = 1000,
                path = "";
            for (const asset of assets) {
                if (!asset.name.startsWith(prefix)) continue;
                const distance = getDistance(name, asset.name);
                if (distance < best) {
                    best = distance;
                    path = asset.path;
                }
            }
            return path;
        };
        const lists = [
            [
                { name: "pose.jpg", path: "first" },
                { name: "pose.gif", path: "tie" },
                { name: "posf.png", path: "wrong-prefix" },
            ],
            [
                { name: "pose.jpg", path: "" },
                { name: "pose.gif", path: "second" },
            ],
            [{ name: "x".repeat(1001), path: "distance-1000" }],
            [{ name: "x".repeat(1000), path: "distance-999" }],
            [{ name: "z".repeat(32768), path: "overflow" }],
            [],
        ];
        const random = rng(123);
        for (let i = 0; i < 40; i++) {
            lists.push(
                Array.from({ length: 20 }, (_, j) => ({
                    name: `${["pose", "x", "😀"][(random() >>> 16) % 3]}${"ab".repeat((random() >>> 16) % 6)}.png`,
                    path: `p${j}`,
                })),
            );
        }
        for (const assets of lists) {
            for (const name of ["pose.png", "pose", "x", ".png", "😀.jpg", "none.png"]) {
                expect(findAssetPrefix(name, assets), name).toBe(fullScan(name, assets));
            }
        }
    });
});
