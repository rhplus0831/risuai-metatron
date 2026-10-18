// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    mergeHypaV2Write,
    mergeHypaV3Write,
    summaryKey,
    type SerializableHypaV2Data,
    type SerializableHypaV3Data,
    type SerializableSummary,
} from "../../../shared/memory.ts";

// Slice 1c of `docs/plan/data-loss-concurrency.md` (audit A2): the job's memory write is placed onto
// the chat's value as stored at the write (`docs/structure/memory.md`, Server Persistence). The two
// merge rules on their own: the unchanged fast path, a text edit kept beside new summaries, the
// algorithm's orphan removals applied to the stored value (an edit of a removed summary goes with
// it), middle deletions and merges kept, the cursor rule (a reset, "delete after", a conversion
// that moves the last message skip; a reset of a wholly cleaned baseline does not), no duplicate
// coverage, the metrics by provenance (equal-valued recomputed metrics carried; stored metrics
// shifted for a returned-error write), legacy `null` and duplicate memos as one identity, the
// stored categories and the legacy field, damaged values, and the V2 rule with a reused id, a
// colliding id, a legacy shape, and duplicate numeric ids. The job path is `memoryJobs.test.ts`.

const summary = (memos: (string | null)[], text = memos.join("+"), extra: Partial<SerializableSummary> = {}) =>
    ({ text, chatMemos: memos as string[], isImportant: false, ...extra }) as SerializableSummary;
const S = {
    a: summary(["m0", "m1"], "A"),
    b: summary(["m2", "m3"], "B"),
    c: summary(["m4", "m5"], "C"),
    d: summary(["m6", "m7"], "D"),
};
const data = (
    summaries: SerializableSummary[],
    extra: Partial<SerializableHypaV3Data> = {},
): SerializableHypaV3Data => ({
    summaries,
    ...extra,
});
const metrics = (
    important: number[] = [],
    recent: number[] = [],
    similar: number[] = [],
    random: number[] = [],
): NonNullable<SerializableHypaV3Data["metrics"]> => ({
    lastImportantSummaries: important,
    lastRecentSummaries: recent,
    lastSimilarSummaries: similar,
    lastRandomSummaries: random,
});
const texts = (merged: SerializableHypaV3Data | null) => merged?.summaries.map((entry) => entry.text);

describe("summaryKey", () => {
    it("is the message ids in first-occurrence order, a legacy null and undefined unified and duplicates once", () => {
        expect(summaryKey({ chatMemos: ["m1", "m0"] })).not.toBe(summaryKey({ chatMemos: ["m0", "m1"] }));
        expect(summaryKey({ chatMemos: [null, "m0", "m0"] })).toBe(summaryKey({ chatMemos: [undefined, "m0"] }));
        expect(summaryKey({ chatMemos: undefined })).toBe("[]");
    });
});

describe("mergeHypaV3Write", () => {
    it("writes the result as it is when the stored value is unchanged since the read (also absent twice)", () => {
        const baseline = data([S.a], { categories: [{ id: "x", name: "X" }] });
        const result = data([S.a, S.b], { metrics: metrics([], [1]) });
        expect(mergeHypaV3Write(baseline, result, structuredClone(baseline), true)).toBe(result);
        expect(mergeHypaV3Write(undefined, result, undefined, true)).toBe(result);
    });

    it("keeps a text, importance, category and tag edit saved meanwhile and appends the new summaries", () => {
        const baseline = data([S.a, S.b]);
        const edited = summary(["m0", "m1"], "A edited", { isImportant: true, categoryId: "cat", tags: ["t"] });
        const stored = data([edited, S.b], { categories: [{ id: "cat", name: "Cat" }] });
        const result = data([S.a, S.b, S.c], { metrics: metrics([], [2], [0]) });
        const merged = mergeHypaV3Write(baseline, result, stored, true)!;
        expect(merged.summaries).toEqual([edited, S.b, S.c]);
        expect(merged.summaries[0]).toBe(edited);
        expect(merged.categories).toEqual([{ id: "cat", name: "Cat" }]);
        expect(merged.metrics).toEqual(metrics([], [2], [0]));
    });

    it("applies the algorithm's orphan removals to the stored value, an edit of a removed summary included", () => {
        const baseline = data([S.a, S.b, S.c]);
        const stored = data([summary(["m0", "m1"], "A edited"), summary(["m2", "m3"], "B edited"), S.c]);
        // Cleanup removed B (its messages are absent from the input); the algorithm appended D.
        const result = data([S.a, S.c, S.d], { metrics: metrics([2], [1], [], [0]) });
        const merged = mergeHypaV3Write(baseline, result, stored, true)!;
        expect(texts(merged)).toEqual(["A edited", "C", "D"]);
        expect(merged.metrics).toEqual(metrics([2], [1], [], [0]));
    });

    it("keeps a middle deletion and a middle merge made meanwhile", () => {
        const baseline = data([S.a, S.b, S.c]);
        const result = data([S.a, S.b, S.c, S.d], { metrics: metrics([], [3], [1], [0]) });
        const deleted = mergeHypaV3Write(baseline, result, data([S.a, S.c]), true)!;
        expect(texts(deleted)).toEqual(["A", "C", "D"]);
        // B's index no longer resolves and is dropped; D and A follow their summaries.
        expect(deleted.metrics).toEqual(metrics([], [2], [], [0]));
        const union = summary(["m0", "m1", "m2", "m3"], "A+B");
        const mergedMiddle = mergeHypaV3Write(baseline, result, data([union, S.c]), true)!;
        expect(texts(mergedMiddle)).toEqual(["A+B", "C", "D"]);
        expect(mergedMiddle.metrics).toEqual(metrics([], [2], [], []));
    });

    it("skips when the stored last summary ends at another message than the kept one", () => {
        const baseline = data([S.a, S.b]);
        const result = data([S.a, S.b, S.c]);
        // A reset, "delete after" the first, the last summary deleted, a conversion ending elsewhere.
        expect(mergeHypaV3Write(baseline, result, data([]), true)).toBeNull();
        expect(mergeHypaV3Write(baseline, result, undefined, true)).toBeNull();
        expect(mergeHypaV3Write(baseline, result, data([S.a]), true)).toBeNull();
        expect(mergeHypaV3Write(baseline, result, data([summary(["m0", "m1", "m2"], "V2")]), true)).toBeNull();
        // A resummarization of the tail that keeps the last message merges.
        const tail = summary(["m0", "m1", "m2", "m3"], "all");
        expect(texts(mergeHypaV3Write(baseline, result, data([tail]), true))).toEqual(["all", "C"]);
    });

    it("appends to a reset of a baseline the algorithm cleaned wholly (both cursors at none)", () => {
        const merged = mergeHypaV3Write(data([S.a]), data([S.d], { metrics: metrics([], [0]) }), data([]), true)!;
        expect(texts(merged)).toEqual(["D"]);
        expect(merged.metrics).toEqual(metrics([], [0]));
    });

    it("skips when an added summary covers a message a stored summary already covers", () => {
        const baseline = data([S.a]);
        const stored = data([S.a, summary(["m2"], "manual")]);
        // The stored tail moved to m2, which the kept cursor (m1) does not match: skipped by the cursor rule.
        expect(mergeHypaV3Write(baseline, data([S.a, S.b]), stored, true)).toBeNull();
        // With `preserveOrphanedMemory`, a stored summary of messages the job also summarized overlaps.
        const preserved = data([S.a, summary(["m9"], "late"), summary(["m1", "m4"], "overlap")]);
        const overlapBase = data([S.a, summary(["m9"], "late"), summary(["m1", "m4"], "overlap")]);
        expect(
            mergeHypaV3Write(
                overlapBase,
                data([...overlapBase.summaries, summary(["m4", "m5"])]),
                { ...preserved, categories: [] },
                true,
            ),
        ).toBeNull();
    });

    it("skips when the result would add a summary with a baseline identity, or either side has duplicate identities", () => {
        const baseline = data([S.a, S.b]);
        const stored = data([summary(["m0", "m1"], "A edited"), S.b]);
        expect(mergeHypaV3Write(baseline, data([S.a, S.b, S.c, S.a]), stored, true)).toBeNull();
        expect(mergeHypaV3Write(data([S.a, S.a]), data([S.a, S.a, S.b]), data([S.a]), true)).toBeNull();
        expect(mergeHypaV3Write(baseline, data([S.a, S.b, S.c]), data([S.a, S.b, S.b]), true)).toBeNull();
    });

    it("matches legacy null and duplicate memos as one identity and compares tails after canonicalization", () => {
        const legacy = summary([null, "m0", "m0"], "legacy first");
        const baseline = data([legacy, S.b]);
        // The algorithm's Set and null→undefined→null round trip canonicalizes the kept summary.
        const canon = summary([null, "m0"], "legacy first");
        const result = data([canon, S.b, S.c], { metrics: metrics([0], [2]) });
        const stored = data([summary([null, "m0", "m0"], "legacy edited"), S.b]);
        const merged = mergeHypaV3Write(baseline, result, stored, true)!;
        expect(texts(merged)).toEqual(["legacy edited", "B", "C"]);
        expect(merged.summaries[0].chatMemos).toEqual([null, "m0", "m0"]);
        expect(merged.metrics).toEqual(metrics([0], [2]));
    });

    it("carries equal-valued recomputed metrics to the merged positions and shifts stored metrics otherwise", () => {
        // Baseline [A, B] with recent [1] (B); the algorithm removes A and adds C: result [B, C], recent [1] (C).
        const baseline = data([S.a, S.b], { metrics: metrics([], [1]) });
        const result = data([S.b, S.c], { metrics: metrics([], [1]) });
        const stored = data([summary(["m0", "m1"], "A edited"), S.b], { metrics: metrics([], [1]) });
        const recomputed = mergeHypaV3Write(baseline, result, stored, true)!;
        expect(texts(recomputed)).toEqual(["B", "C"]);
        expect(recomputed.metrics).toEqual(metrics([], [1]));
        // A returned-error write carries the baseline metrics: the stored selection (B at 1) shifts to 0.
        const errored = mergeHypaV3Write(baseline, data([S.b], { metrics: metrics([], [1]) }), stored, false)!;
        expect(texts(errored)).toEqual(["B"]);
        expect(errored.metrics).toEqual(metrics([], [0]));
        // Without stored metrics, a non-recomputed write has none.
        const none = mergeHypaV3Write(baseline, data([S.b], { metrics: metrics([], [1]) }), data([S.b]), false)!;
        expect(none.metrics).toBeUndefined();
    });

    it("drops metrics indices that are not integers, negative, or out of range", () => {
        const baseline = data([S.a]);
        const result = data([S.a, S.b], { metrics: metrics([-1, 0.5, 2, 1], [0]) });
        const merged = mergeHypaV3Write(baseline, result, data([S.a], { categories: [] }), true)!;
        expect(merged.metrics).toEqual(metrics([1], [0]));
        const stored = data([S.a], { metrics: metrics([7, -2, 0]) });
        expect(mergeHypaV3Write(baseline, data([S.a]), stored, false)!.metrics).toEqual(metrics([0]));
    });

    it("takes the other fields from the stored value and drops the legacy field when the result dropped it", () => {
        const baseline = data([S.a], { lastSelectedSummaries: [0], modalSettings: { displayMode: "All" } as any });
        const stored = data([S.a], {
            lastSelectedSummaries: [0],
            categories: [{ id: "k", name: "Kept" }],
            modalSettings: { displayMode: "Recent" } as any,
        });
        const merged = mergeHypaV3Write(baseline, data([S.a, S.b], { metrics: metrics() }), stored, true)!;
        expect(merged.categories).toEqual([{ id: "k", name: "Kept" }]);
        expect(merged.modalSettings).toEqual({ displayMode: "Recent" });
        expect("lastSelectedSummaries" in merged).toBe(false);
        const kept = mergeHypaV3Write(baseline, data([S.a, S.b], { lastSelectedSummaries: [] }), stored, true)!;
        expect(kept.lastSelectedSummaries).toEqual([0]);
    });

    it("appends onto the modal's empty initialization of a chat without memory data", () => {
        const stored = data([], { categories: [{ id: "", name: "Unclassified" }], lastSelectedSummaries: [] });
        const merged = mergeHypaV3Write(undefined, data([S.a], { metrics: metrics([], [0]) }), stored, true)!;
        expect(merged).toEqual({
            summaries: [S.a],
            categories: [{ id: "", name: "Unclassified" }],
            metrics: metrics([], [0]),
        });
    });

    it("skips a divergent write over a damaged value instead of throwing", () => {
        const result = data([S.a, S.b]);
        expect(mergeHypaV3Write(data([S.a]), result, { summaries: "no" } as any, true)).toBeNull();
        expect(mergeHypaV3Write(data([S.a]), result, { summaries: [null] } as any, true)).toBeNull();
        expect(
            mergeHypaV3Write(data([S.a]), result, { summaries: [{ text: "x", chatMemos: "m0" }] } as any, true),
        ).toBeNull();
        expect(mergeHypaV3Write({ summaries: 1 } as any, result, data([S.a, S.b]), true)).toBeNull();
        expect(mergeHypaV3Write(data([S.a]), result, [] as any, true)).toBeNull();
    });
});

describe("mergeHypaV2Write", () => {
    const main = (id: number, memos: string[], text = `M${id}`) => ({
        id,
        text,
        chatMemos: memos,
        lastChatMemo: memos.at(-1)!,
    });
    const chunk = (mainChunkID: number, text: string) => ({ mainChunkID, text });
    const v2 = (
        mainChunks: SerializableHypaV2Data["mainChunks"],
        chunks: SerializableHypaV2Data["chunks"] = mainChunks.map((entry) => chunk(entry.id, `${entry.text} part`)),
    ): SerializableHypaV2Data => ({ lastMainChunkID: mainChunks.at(-1)?.id ?? 0, mainChunks, chunks });

    it("writes the result as it is when unchanged, legacy shapes included", () => {
        const legacy = {
            chunks: [{ targetId: "m0", text: "old" }],
            mainChunks: [{ targetId: "m0", text: "old" }],
        } as any;
        const result = v2([main(1, ["m0", "m1"])]);
        expect(mergeHypaV2Write(legacy, result, structuredClone(legacy))).toBe(result);
        expect(mergeHypaV2Write(undefined, result, undefined)).toBe(result);
    });

    it("keeps a stored chunk text edit, removes the cleaned main chunk with its chunks, and appends the new ones", () => {
        const baseline = v2([main(1, ["m0", "m1"]), main(2, ["m2", "m3"])]);
        const stored = v2([main(1, ["m0", "m1"]), main(2, ["m2", "m3"])], [chunk(1, "M1 part"), chunk(2, "M2 edited")]);
        // Cleanup removed main 1 and reset the counter to 2; the new chunk took id 3.
        const result = v2([main(2, ["m2", "m3"]), main(3, ["m4", "m5"])], [chunk(2, "M2 part"), chunk(3, "M3 part")]);
        const merged = mergeHypaV2Write(baseline, result, stored)!;
        expect(merged.mainChunks.map((entry) => entry.id)).toEqual([2, 3]);
        expect(merged.chunks).toEqual([chunk(2, "M2 edited"), chunk(3, "M3 part")]);
        expect(merged.lastMainChunkID).toBe(3);
    });

    it("supports a new chunk reusing a removed chunk's id, with the old children gone first", () => {
        const baseline = v2([main(1, ["m0", "m1"]), main(2, ["m2", "m3"])]);
        const stored = v2([main(1, ["m0", "m1"]), main(2, ["m2", "m3"])], [chunk(1, "M1 part"), chunk(2, "M2 edited")]);
        // Cleanup removed main 2 (counter back to 1); the new chunk reused id 2 for other messages.
        const result = v2(
            [main(1, ["m0", "m1"]), main(2, ["m4", "m5"], "new")],
            [chunk(1, "M1 part"), chunk(2, "new part")],
        );
        const merged = mergeHypaV2Write(baseline, result, stored)!;
        expect(merged.mainChunks.map((entry) => [entry.id, entry.text])).toEqual([
            [1, "M1"],
            [2, "new"],
        ]);
        expect(merged.chunks).toEqual([chunk(1, "M1 part"), chunk(2, "new part")]);
    });

    it("skips an added id colliding with a retained stored chunk, a moved tail, and overlapping messages", () => {
        const baseline = v2([main(1, ["m0", "m1"])]);
        const result = v2([main(1, ["m0", "m1"]), main(2, ["m2", "m3"])]);
        // The editor kept main 1 and a manual main 2 of other messages: the tail moved and the id collides.
        expect(mergeHypaV2Write(baseline, result, v2([main(1, ["m0", "m1"]), main(2, ["m9"])]))).toBeNull();
        expect(mergeHypaV2Write(baseline, result, v2([]))).toBeNull();
        const overlap = v2([main(1, ["m0", "m1"]), main(5, ["m3"])]);
        expect(
            mergeHypaV2Write(
                v2([main(1, ["m0", "m1"]), main(5, ["m3"])]),
                v2([main(1, ["m0", "m1"]), main(5, ["m3"]), main(6, ["m3", "m4"])]),
                { ...overlap, chunks: [] },
            ),
        ).toBeNull();
    });

    it("skips a divergent write over a legacy or damaged value and over duplicate numeric ids", () => {
        const legacy = {
            chunks: [{ targetId: "m0", text: "old" }],
            mainChunks: [{ targetId: "m0", text: "old" }],
        } as any;
        const result = v2([main(1, ["m0", "m1"])]);
        expect(mergeHypaV2Write(legacy, result, v2([]))).toBeNull();
        expect(mergeHypaV2Write(v2([]), result, legacy)).toBeNull();
        expect(mergeHypaV2Write(v2([]), result, { mainChunks: [{ id: "1" }], chunks: [] } as any)).toBeNull();
        const twice = v2([main(1, ["m0"]), main(1, ["m1"])]);
        expect(
            mergeHypaV2Write(twice, v2([...twice.mainChunks, main(2, ["m2"])]), { ...twice, chunks: [] }),
        ).toBeNull();
        expect(
            mergeHypaV2Write(
                v2([main(1, ["m0"])]),
                v2([main(1, ["m0"]), main(2, ["m1"])]),
                v2([main(1, ["m0"]), main(1, ["m0"])]),
            ),
        ).toBeNull();
    });
});
