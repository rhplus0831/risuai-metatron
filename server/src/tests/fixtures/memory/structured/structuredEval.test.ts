// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { MemoryEvent, MemoryManifestItem } from "../../../../../../shared/structuredMemory.ts";
import { analysisOverhead, resolveLabel, scoreProbe, sendLedger, summarizeScores, writerLedger } from "./evaluate.ts";
import { createFixture, createStubTokenizers, PINNED_PRESET, type FixtureOptions } from "./harness.ts";
import {
    createScriptedChat,
    createScriptedEmbeddings,
    lexicalEmbedding,
    SCRIPTED_CHAT_URL,
    SCRIPTED_EMBEDDING_URL,
    ScriptedRequestMismatch,
    type ScriptedCall,
} from "./scriptedWriter.ts";
import {
    charMessageId,
    eventLabel,
    generateStory,
    MIN_STORY_TURNS,
    pageLabel,
    storyMessages,
    storySizes,
    threadLabel,
    turnOfMessageId,
    userMessageId,
    type Probe,
} from "./story.ts";

const event = (id: string, turns: number[]): MemoryEvent => ({
    id,
    title: id,
    summary: `Remember ${id}`,
    participants: [],
    storyTime: { text: "" },
    keyLines: [],
    stateChanges: [],
    knowledge: [],
    relationshipShifts: [],
    openThreads: { add: [], close: [], transitions: [] },
    status: "active",
    sources: turns.map((turn) => ({ messageId: charMessageId(turn), hash: "source", index: turn * 2 - 1 })),
    writerRun: `run-${id}`,
    createdRevision: 1,
});

const plainRecords = () => ({
    events: [event("a", [1]), event("b", [2, 3]), event("c", [4])],
    pages: [
        {
            id: "p",
            type: "character" as const,
            title: "Mina: 민아",
            aliases: [],
            contextMode: "auto" as const,
            sections: [],
            links: [],
            retrieval: { keywords: [] },
            history: [],
        },
    ],
    threads: [{ id: "t", title: "Keep the promise", who: ["p"], state: "open" as const }],
});

const probe = (overrides: Partial<Probe> = {}): Probe => ({
    id: "probe",
    kind: "needed",
    query: "Remember",
    needed: [],
    forbidden: [],
    distractors: [],
    mirrors: [],
    note: "",
    ...overrides,
});

const item = (id: string, lane: MemoryManifestItem["lane"] = "events"): MemoryManifestItem => ({
    id,
    kind: lane === "pages" ? "page" : "event",
    lane,
    tokens: 1,
    reason: "selected",
    verified: false,
});

const fixture = (options: Pick<FixtureOptions, "story" | "algorithm" | "maxContext">) => {
    const result = createFixture({
        ...options,
        tokenizers: createStubTokenizers(),
        clock: { now: 1_000_000 },
        limits: { taskDeadlineMs: 6_000_000, drainWaitMs: 600_000 },
    });
    onTestFinished(() => result.dispose());
    return result;
};

describe("structured memory evaluation", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    afterEach(() => vi.useRealTimers());

    it("generates reproducible Korean and English chats with ten characters and labelled probes", () => {
        for (const language of ["ko", "en"] as const) {
            for (const turns of [20, 1000]) {
                const options = { language, turns, seed: 17 };
                const story = generateStory(options);
                expect(JSON.stringify(generateStory(options))).toBe(JSON.stringify(story));
                expect(story.turns).toHaveLength(turns);
                expect(story.cast).toHaveLength(10);
                expect(new Set(story.cast).size).toBe(10);
                expect(new Set(story.probes.map(({ kind }) => kind))).toEqual(
                    new Set(["needed", "mustNotLeak", "knowledge", "comparison", "unanswerable"]),
                );
                const messages = storyMessages(story);
                expect(messages).toHaveLength(turns * 2);
                expect(new Set(messages.map(({ chatId }) => chatId)).size).toBe(turns * 2);
                for (const entry of story.turns) {
                    expect(messages.slice((entry.turn - 1) * 2, entry.turn * 2)).toEqual([
                        { chatId: userMessageId(entry.turn), role: "user", data: entry.user },
                        { chatId: charMessageId(entry.turn), role: "char", data: entry.char },
                    ]);
                    expect(turnOfMessageId(entry.userId)).toBe(entry.turn);
                    expect(turnOfMessageId(entry.charId)).toBe(entry.turn);
                }
                expect(storySizes(story)).toEqual({
                    messages: turns * 2,
                    messageBytes: messages.reduce((sum, { data }) => sum + Buffer.byteLength(data), 0),
                    jsonBytes: Buffer.byteLength(JSON.stringify(story)),
                });
                if (turns === 20) {
                    expect(storyMessages(generateStory({ ...options, seed: 18 }))).not.toEqual(messages);
                    expect(messages.some(({ data }) => /[가-힣]/u.test(data))).toBe(language === "ko");
                    expect(story.probes.every(({ query }) => query.trim().length > 0)).toBe(true);
                }
            }
        }
        expect(() => generateStory({ language: "en", turns: MIN_STORY_TURNS - 1 })).toThrow(/at least/);
    });

    it("scores manifest capture, exclusion and complete comparisons over distinct records", () => {
        const records = plainRecords();
        const selected = { items: [item("a"), item("c")], cardText: "" };
        const absent = { items: [], cardText: "a b c appear only in prose" };
        const first = scoreProbe(probe({ needed: ["event:1", "event:2", "event:3"] }), selected, records);
        expect(first.needed.map(({ found }) => found)).toEqual([true, false, false]);
        expect(first.pass).toBe(false);
        const second = scoreProbe(probe({ needed: ["event:1", "event:4"] }), selected, records);
        expect(second.pass).toBe(true);
        const forbidden = probe({ kind: "mustNotLeak", forbidden: ["event:1", "event:2"] });
        const leaked = scoreProbe(forbidden, selected, records);
        const excluded = scoreProbe({ ...forbidden, forbidden: ["event:3", "event:4"] }, absent, records);
        expect(leaked.pass).toBe(false);
        expect(excluded.pass).toBe(true);
        const comparison = probe({ kind: "comparison", needed: ["event:1", "event:4"] });
        const complete = scoreProbe(comparison, selected, records);
        const incomplete = scoreProbe(comparison, { items: [item("a")], cardText: "c" }, records);
        expect(complete).toMatchObject({ allPartsPresent: true, pass: true });
        expect(incomplete).toMatchObject({ allPartsPresent: false, pass: false });
        expect(summarizeScores([first, second, leaked, excluded, complete, incomplete])).toMatchObject([
            { kind: "needed", capture: { found: 2, total: 3 } },
            { kind: "mustNotLeak", exclusion: { absent: 2, total: 3 } },
            { kind: "comparison", allParts: { present: 1, total: 2 } },
        ]);
    });

    it("requires the secret only in the unaware character's does-not-know text", () => {
        const records = plainRecords();
        const knowledge = probe({
            kind: "knowledge",
            needed: [pageLabel("Mina: 민아")],
            boundary: { page: pageLabel("Mina: 민아"), fact: "the key is under the bell" },
        });
        const fact = knowledge.boundary!.fact;
        const scores = [
            [`[m:p] Mina | does not know: "${fact}"`, true],
            [`[m:p] Mina | knows: "${fact}"`, false],
            [`[m:p] Mina | knows: "${fact}" | does not know: "${fact}"`, false],
            [`[m:someone-else] Mina | does not know: "${fact}"`, false],
            ["", false],
        ].map(([cardText, pass]) => {
            const score = scoreProbe(knowledge, { items: [item("p", "pages")], cardText: String(cardText) }, records);
            expect(score.boundary?.pass).toBe(pass);
            expect(score.pass).toBe(pass);
            return score;
        });
        expect(summarizeScores(scores)[0].boundary).toEqual({ held: 1, total: 5 });
    });

    it("counts only labelled selected distractors without grading an unanswerable query", () => {
        const records = plainRecords();
        const question = probe({ kind: "unanswerable", distractors: ["event:1", "event:2", "event:3"] });
        const send = {
            items: [item("a"), item("c"), item("p", "pages")],
            cardText: "",
            eventsOpen: true,
            eventReasons: ["similar"],
        };
        const score = scoreProbe(question, send, records);
        expect(score.distractors.map(({ selected }) => selected)).toEqual([true, false, false]);
        expect(score.pass).toBeUndefined();
        expect(score).toMatchObject({
            selectedByLane: { events: 2, pages: 1 },
            eventsOpen: true,
            eventReasons: ["similar"],
        });
        const control = scoreProbe({ ...question, distractors: [] }, send, records);
        expect(control.pass).toBeUndefined();
        expect(summarizeScores([score, control])[0].distractors).toEqual({ selected: 1, total: 2 });
    });

    it("resolves labels to records and rejects every unresolved scoring label", () => {
        const records = plainRecords();
        records.events.unshift({ ...event("old", [1]), status: "retracted" });
        expect(resolveLabel(eventLabel(1), records)).toEqual({ label: "event:1", kind: "event", id: "a" });
        expect(resolveLabel(pageLabel("Mina: 민아"), records)).toEqual({
            label: "page:Mina: 민아",
            kind: "page",
            id: "p",
        });
        expect(resolveLabel(threadLabel("Keep the promise"), records)).toEqual({
            label: "thread:Keep the promise",
            kind: "thread",
            id: "t",
        });
        for (const label of ["event:99", "page:missing", "thread:missing"]) {
            expect(() => resolveLabel(label, records)).toThrow(`Unresolved label ${label}`);
            for (const field of ["needed", "forbidden", "distractors", "mirrors"] as const) {
                expect(() => scoreProbe(probe({ [field]: [label] }), { items: [], cardText: "" }, records)).toThrow(
                    `Unresolved label ${label}`,
                );
            }
        }
        expect(() =>
            scoreProbe(
                probe({ boundary: { page: "page:missing", fact: "secret" } }),
                { items: [], cardText: "" },
                records,
            ),
        ).toThrow("Unresolved label page:missing");
    });

    it("rejects mismatched scripted requests and supplies deterministic lexical embeddings", async () => {
        const story = generateStory({ language: "en", turns: 20, seed: 17 });
        const chat = createScriptedChat({ story });
        const entry = story.turns[0];
        const request = (system: string, content: string) =>
            chat.fetchImpl(SCRIPTED_CHAT_URL, {
                method: "POST",
                body: JSON.stringify({
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content },
                    ],
                }),
            });
        const analysisFrame = "You keep the memory of a long roleplay.";
        const window = `Pages:\n(none)\n\nScene:\n(none)\n\nOpen threads:\n(none)\n\nBefore these messages:\n(none)\n\nMessages to record:\n[m:${entry.userId}] user: ${entry.user}\n[m:${entry.charId}] assistant: ${entry.char}`;
        await expect(request(analysisFrame, window.replace(entry.char, "wrong text"))).rejects.toBeInstanceOf(
            ScriptedRequestMismatch,
        );
        await expect(request("Unrecognized prompt", "hello")).rejects.toBeInstanceOf(ScriptedRequestMismatch);
        await expect(chat.fetchImpl("https://unexpected.invalid")).rejects.toBeInstanceOf(ScriptedRequestMismatch);
        expect(chat.calls).toEqual([]);
        await request(analysisFrame, window);
        const patchFrame = "You keep the pages of a long roleplay's memory. Update them";
        const target = entry.patches[0];
        const page = { id: "p", type: target.type, title: target.title, sections: [], notShown: [] };
        const patchRequest = `Pages:\n${JSON.stringify(page)}\n\nEvent:\n${JSON.stringify({ title: entry.analysis.title, summary: entry.analysis.summary })}`;
        await expect(
            request(patchFrame, patchRequest.replace(entry.analysis.summary, "another event")),
        ).rejects.toBeInstanceOf(ScriptedRequestMismatch);
        await request(patchFrame, patchRequest);
        const patch = JSON.parse(chat.calls[1].answer).patches[0] as { heading: string; body: string };
        const compactionFrame = "You keep the pages of a long roleplay's memory. Make one section";
        const section = `Page:\n${JSON.stringify({ title: target.title, heading: patch.heading })}\n\nSection:\n`;
        await expect(request(compactionFrame, section + "unwritten body")).rejects.toBeInstanceOf(
            ScriptedRequestMismatch,
        );
        await request(compactionFrame, section + patch.body);
        expect(chat.calls.map(({ kind }) => kind)).toEqual(["analysis", "patch", "compaction"]);

        const embeddings = createScriptedEmbeddings();
        const texts = ["lantern 별빛", "별빛 LANTERN", ""];
        const response = await embeddings.fetchImpl(SCRIPTED_EMBEDDING_URL, { body: JSON.stringify({ input: texts }) });
        const { data } = (await response.json()) as { data: { embedding: number[] }[] };
        expect(data.map(({ embedding }) => embedding)).toEqual(texts.map(lexicalEmbedding));
        expect(data[0].embedding).toEqual(data[1].embedding);
        expect(Math.hypot(...data[0].embedding)).toBeCloseTo(1);
        expect(data[2].embedding.every((value) => value === 0)).toBe(true);
        expect(embeddings.counts).toEqual({ requests: 1, texts: 3 });
        await expect(embeddings.fetchImpl("https://unexpected.invalid")).rejects.toBeInstanceOf(
            ScriptedRequestMismatch,
        );
    });

    it("records bilingual chats through the writer and excludes retracted, stale and hidden records from sends", async () => {
        for (const language of ["ko", "en"] as const) {
            const story = generateStory({ language, turns: 20, seed: 17 });
            const f = fixture({ story, algorithm: "structuredMemory" });
            const rebuilt = await f.rebuild();
            expect(rebuilt.windows).toBe(20);
            expect(rebuilt.events.at(-1)?.status).toMatchObject({ state: "done", reason: "rebuilt" });
            const records = f.records();
            expect(records.runs).toHaveLength(20);
            expect(records.runs.every(({ result }) => result === "recorded")).toBe(true);
            expect(f.calls.filter(({ kind }) => kind === "analysis").map(({ turn }) => turn)).toEqual(
                story.turns.map(({ turn }) => turn),
            );
            expect(f.calls.some(({ kind }) => kind === "patch")).toBe(true);
            expect(
                records.pages.some(({ sections }) =>
                    sections.some(({ body, provenance }) => body.length > 0 && provenance.length > 0),
                ),
            ).toBe(true);
            for (const p of story.probes) {
                for (const label of [
                    ...p.needed,
                    ...p.forbidden,
                    ...p.distractors,
                    ...p.mirrors,
                    ...(p.boundary ? [p.boundary.page] : []),
                ]) {
                    expect(resolveLabel(label, records).id).not.toBe("");
                }
            }
            const gift = story.probes.find(({ id }) => id === "needed-event")!;
            const giftId = resolveLabel(gift.needed[0], records).id;
            const storedGift = records.events.find(({ id }) => id === giftId)!;
            const scriptedGift = story.turns.find(({ charId }) =>
                storedGift.sources.some(({ messageId }) => messageId === charId),
            )!;
            expect(storedGift.summary).toBe(scriptedGift.analysis.summary);
            expect(storedGift.keyLines).toEqual(scriptedGift.analysis.keyLines);

            for (const p of story.probes.filter(({ setup }) => setup !== undefined)) {
                const id = resolveLabel(p.forbidden[0], f.records()).id;
                f.applySetup(p.setup!);
                const changed = f.records();
                if (p.setup!.kind === "never") {
                    expect(changed.pages.find((page) => page.id === id)?.contextMode).toBe("never");
                } else if (p.setup!.kind === "retract") {
                    expect(changed.events.find((e) => e.id === id)?.status).toBe("retracted");
                } else if (p.setup!.kind === "editMessage") {
                    const setup = p.setup!;
                    expect(f.messages().find(({ chatId }) => chatId === setup.messageId)?.data).toBe(setup.text);
                }
                const send = await f.send(p.query);
                expect(send.items.some((selected) => selected.id === id)).toBe(false);
                expect(scoreProbe(p, send, changed).forbidden).toEqual([{ label: p.forbidden[0], id, leaked: false }]);
                if (p.setup!.kind !== "retract") {
                    expect(send.excluded).toContainEqual(
                        expect.objectContaining({ id, reason: p.setup!.kind === "never" ? "never" : "stale" }),
                    );
                }
            }
        }
    });

    it("rejects a rebuild when a window fails recording instead of returning figures", async () => {
        for (const failure of ["invalid output", "mismatched request"]) {
            const story = generateStory({ language: "en", turns: 20, seed: 17 });
            if (failure === "invalid output") {
                story.turns[6].analysis.summary = "";
            }
            const f = fixture({ story, algorithm: "structuredMemory" });
            if (failure === "mismatched request") {
                f.applySetup({ kind: "editMessage", messageId: story.turns[6].charId, text: "Outside the script." });
            }
            await expect(f.rebuild()).rejects.toThrow(/The rebuild ended failed/);
            expect(f.events.at(-1)?.status.state).toBe("failed");
            expect(f.records().events).toEqual([]);
        }
    });

    it("accounts for every writer call kind, send text and analysis overhead", async () => {
        const call = (kind: ScriptedCall["kind"], input: string[], answer: string): ScriptedCall => ({
            index: 0,
            kind,
            messages: input.map((content) => ({ role: "user", content })),
            answer,
        });
        const calls = [
            call("analysis", ["A", "가"], "OK"),
            call("patch", ["patch"], "나"),
            call("compaction", ["compact", "now"], "C"),
            call("summary", ["summary"], "요약"),
            call("compaction", ["again"], "DD"),
        ];
        const count = async (text: string) => Buffer.byteLength(text);
        expect(await writerLedger(calls, count)).toEqual({
            analysis: { calls: 1, inputTokens: 5, outputTokens: 2, inputChars: 3, outputChars: 2 },
            patch: { calls: 1, inputTokens: 5, outputTokens: 3, inputChars: 5, outputChars: 1 },
            compaction: { calls: 2, inputTokens: 16, outputTokens: 3, inputChars: 16, outputChars: 3 },
            summary: { calls: 1, inputTokens: 7, outputTokens: 6, inputChars: 7, outputChars: 2 },
        });
        expect(await sendLedger({ cardText: "기억", rawTexts: ["hi", "별"] }, count)).toEqual({
            cardTokens: 6,
            rawTokens: 5,
            rawEntries: 2,
        });
        expect(await sendLedger({ cardText: "", rawTexts: [] }, count)).toEqual({
            cardTokens: 0,
            rawTokens: 0,
            rawEntries: 0,
        });
        const analyses = Array.from({ length: 20 }, (_, index) => call("analysis", ["x".repeat(index + 2)], ""));
        const overhead = await analysisOverhead([...analyses, call("patch", ["ignored"], "")], () => "x", count);
        expect(overhead).toEqual([
            {
                part: "first tenth",
                calls: 2,
                inputTokens: 5,
                windowTokens: 2,
                overheadPerCall: 1.5,
                slots: { cast: 0, scene: 0, threads: 0, previous: 0 },
            },
            {
                part: "last tenth",
                calls: 2,
                inputTokens: 41,
                windowTokens: 2,
                overheadPerCall: 19.5,
                slots: { cast: 0, scene: 0, threads: 0, previous: 0 },
            },
            {
                part: "all",
                calls: 20,
                inputTokens: 230,
                windowTokens: 20,
                overheadPerCall: 10.5,
                slots: { cast: 0, scene: 0, threads: 0, previous: 0 },
            },
        ]);
    });

    it("keeps per-chat ledgers beside HypaV3 on the same chat and memory budget", async () => {
        const story = generateStory({ language: "en", turns: 40, seed: 17 });
        const structured = fixture({ story, algorithm: "structuredMemory", maxContext: 4096 });
        const hypa = fixture({ story, algorithm: "hypaV3", maxContext: 4096 });
        expect(structured.messages()).toEqual(hypa.messages());
        for (const f of [structured, hypa]) {
            const presets = f.store.get(f.kinds.get("hypaV3Presets")!, "main")!.data as {
                items: { settings: unknown }[];
            };
            expect(presets.items[0].settings).toMatchObject(PINNED_PRESET);
        }
        await structured.rebuild();
        const summarized = await hypa.summarize();
        expect(summarized.handOffs).toBeGreaterThan(0);
        expect(summarized.events.at(-1)?.status.state).toBe("done");
        expect(hypa.calls.length).toBeGreaterThan(0);
        expect(hypa.calls.every(({ kind }) => kind === "summary")).toBe(true);
        for (const f of [structured, hypa]) {
            const count = (text: string) => f.tokenizers.count("claude", text);
            const ledger = await writerLedger(f.calls, count);
            expect(Object.values(ledger).reduce((sum, row) => sum + row.calls, 0)).toBe(f.calls.length);
            expect(ledger.summary.calls).toBe(f === hypa ? f.calls.length : 0);
            const before = f.calls.length;
            const send = await f.send(story.probes[0].query);
            const spent = await sendLedger(send, count);
            expect(spent).toEqual({
                cardTokens: Math.ceil(send.cardText.length / 4),
                rawTokens: send.rawTexts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
                rawEntries: send.rawTexts.length,
            });
            expect(spent.cardTokens).toBeGreaterThan(0);
            expect(spent.rawEntries).toBeGreaterThan(0);
            expect(f.calls).toHaveLength(before);
        }
    });
});
