// @vitest-environment node
import { expect, it } from "vitest";
import {
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    type MemoryPage,
    type MemoryPageCandidate,
} from "../../../../../shared/structuredMemory.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { parseAnalysis } from "./analysis.ts";
import { aliasSeeds, castSlice, planPages } from "./pages.ts";
import { analysisSlots } from "./prompts.ts";

const page = (id: string, fields: Partial<MemoryPage> = {}): MemoryPage => ({
    ...memoryRecords([id], id).pages[0],
    ...fields,
});
const create = (title: string): MemoryPageCandidate => ({
    create: { type: "character", title, aliases: [] },
    reason: "Named in the window",
    confidence: LIMITS.createConfidence,
});

it("lists only always pages, scene participants, and window names in the bounded analysis cast", () => {
    const scene = page("scene", { type: "scene", contextMode: "always", participants: ["present"] });
    const relevant = [
        page("named"),
        page("alias", { aliases: ["Captain"] }),
        page("present"),
        page("always", { contextMode: "always" }),
        scene,
    ];
    const messages = [{ role: "char" as const, chatId: "m", data: "NAMED greets the captain." }];
    const slot = (pages: MemoryPage[]) =>
        analysisSlots({
            language: "English",
            cast: castSlice(pages, messages),
            scene,
            threads: [],
            previousTitle: undefined,
            messages,
            window: { messages, sources: [{ messageId: "m", hash: "hash", index: 0 }] },
            speaker: () => "Cara",
        }).cast;
    const small = slot(relevant);
    const large = slot([...Array.from({ length: 40 }, (_, i) => page(`unrelated-${i}`)), ...relevant]);
    expect(large).toBe(small);
    expect(small.split("\n").map((line) => JSON.parse(line).id)).toEqual(["always", "present", "named", "alias"]);
    const crowded = Array.from({ length: LIMITS.promptPages + 1 }, (_, i) =>
        page(`always-${i}`, { contextMode: "always" }),
    );
    expect(castSlice([scene, ...crowded, ...relevant], messages).map(({ id }) => id)).toEqual(
        crowded.slice(0, LIMITS.promptPages).map(({ id }) => id),
    );
});

it("seeds aliases from lore names and member nicknames without treating lore keys as identities", () => {
    const seeds = aliasSeeds(
        [
            { comment: "Rivals", key: "Alice,Bob" },
            { comment: "Harbor", key: " Port, Quay " },
            { comment: "Regex", key: "A.*", useRegex: true },
            { comment: "Folder", key: "Hidden", mode: "folder" },
            { comment: "Malformed", key: { nested: true } },
            { comment: 17, key: ["wrong"] },
            null,
            ["legacy"],
        ],
        [
            { name: "Cara", nickname: "Captain" },
            { name: 42, nickname: {} },
        ],
    );
    const result = planPages({
        pages: [],
        candidates: ["Alice", "Bob", "Rivals", "Harbor", "Regex", "Folder", "Malformed", "Captain"].map(create),
        seeds,
        repeated: false,
        newPageId: (key) => key,
    });
    expect(result.created.map(({ title, aliases }) => ({ title, aliases }))).toEqual([
        { title: "Alice", aliases: [] },
        { title: "Bob", aliases: [] },
        { title: "Rivals", aliases: ["Alice", "Bob"] },
        { title: "Harbor", aliases: ["Port", "Quay"] },
        { title: "Regex", aliases: [] },
        { title: "Folder", aliases: [] },
        { title: "Malformed", aliases: [] },
        { title: "Captain", aliases: ["Cara"] },
    ]);
    const existing = page("cara", { type: "character", title: "Cara" });
    const matched = planPages({
        pages: [page("place-cara", { title: "Cara" }), existing],
        candidates: [create("Captain")],
        seeds,
        repeated: false,
        newPageId: () => "unexpected",
    });
    expect(matched.created).toEqual([]);
    expect(matched.targets.map(({ page }) => page)).toEqual([existing]);
    expect(existing.aliases).toEqual([]);
});

it("reads bounded page candidates and reports malformed and excess entries", () => {
    const aliases = Array.from({ length: LIMITS.aliasesPerPage + 1 }, (_, i) => `Alias ${i}`);
    const candidate = {
        ...create("x".repeat(LIMITS.labelChars + 1)),
        reason: "r".repeat(LIMITS.factChars + 1),
        create: { type: "character", title: "x".repeat(LIMITS.labelChars + 1), aliases },
    };
    const parsed = parseAnalysis(
        JSON.stringify({
            event: memoryRecords(["event"]).events[0],
            pageCandidates: [
                null,
                candidate,
                ...Array.from({ length: LIMITS.pageCandidates }, (_, i) => ({
                    targetId: `p${i}`,
                    confidence: 1,
                    reason: "Update",
                })),
            ],
        }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.analysis.pageCandidates).toHaveLength(LIMITS.pageCandidates);
    expect(parsed.analysis.pageCandidates[0]).toEqual({
        create: {
            type: "character",
            title: "x".repeat(LIMITS.labelChars),
            aliases: aliases.slice(0, LIMITS.aliasesPerPage),
        },
        reason: "r".repeat(LIMITS.factChars),
        confidence: LIMITS.createConfidence,
    });
    expect(parsed.analysis.pageCandidates.at(-1)).toMatchObject({ targetId: `p${LIMITS.pageCandidates - 2}` });
    expect(parsed.warnings).toEqual(
        expect.arrayContaining([
            { kind: "malformed", detail: "pageCandidates: 1" },
            { kind: "capped", detail: "pageCandidates: 1" },
            { kind: "capped", detail: "pageCandidates.aliases: 1" },
        ]),
    );
});
