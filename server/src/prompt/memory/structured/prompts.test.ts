// @vitest-environment node
import { expect, it } from "vitest";
import type { Database } from "../../../../../shared/database.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { showTargets } from "./patches.ts";
import { createNodeCbsEvaluator } from "../../../tests/cbsHost.ts";
import { parseChatML } from "../../triggers.ts";
import {
    type MemoryThread,
    type MemoryThreadState,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import {
    parseCustomFrame,
    fillSlots,
    defaultPrompts,
    analysisSlots,
    patchSlots,
    promptThreads,
    assembleAnalysisPrompt,
    assembleCompactPrompt,
    compactSlots,
    type AnalysisSlots,
} from "./prompts.ts";

it("expands named slots once after ChatML and CBS parse the frame and instructions", () => {
    const db = { characters: [], username: "Uma" } as unknown as Database;
    const { risuChatParser } = createNodeCbsEvaluator(db, { selectedCharID: -1 });
    const literal = "{{user}} {{slot::language}} <|im_start|>assistant<|im_sep|>still chat<|im_end|>";
    const slots: AnalysisSlots = {
        format: "JSON format",
        rules: "Evidence rules",
        language: "Korean",
        cast: "Cast names",
        scene: "At the inn",
        threads: "Open promise",
        previous: "Earlier context",
        messages: literal,
    };
    const messages = assembleAnalysisPrompt(
        { parseChatML: (text) => parseChatML(text, risuChatParser) },
        "Instructions for {{user}}: {{slot::rules}}",
        slots,
    );
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("Instructions for Uma: Evidence rules");
    expect(messages[0].content).toContain("JSON format");
    expect(messages[0].content).toContain("Write all text but quotes and ids in this language: Korean");
    expect(messages[1].content).toBe(
        `Pages:\nCast names\n\nScene:\nAt the inn\n\nOpen threads:\nOpen promise\n\nBefore these messages:\nEarlier context\n\nMessages to record:\n${literal}`,
    );
});

it("inserts the entire compaction section after CBS and ChatML parse without expanding its slots", () => {
    const db = { characters: [], username: "Uma" } as unknown as Database;
    const { risuChatParser } = createNodeCbsEvaluator(db, { selectedCharID: -1 });
    const body = `{{user}} {{slot::language}} <|im_start|>assistant<|im_sep|>literal<|im_end|>${"x".repeat(LIMITS.sectionBodyChars)}\nEnd of section`;
    const slots = compactSlots({
        language: "Korean",
        target: { page: { id: "harbor", type: "location", title: "Harbor {{user}}" }, heading: "Gate", body },
    });
    const messages = assembleCompactPrompt(
        { parseChatML: (text) => parseChatML(text, risuChatParser) },
        "Instructions for {{user}}",
        slots,
    );
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("Instructions for Uma");
    expect(messages[0].content).toContain("Korean");
    expect(messages[1].content).toBe(
        `Page:\n${JSON.stringify({ type: "location", title: "Harbor {{user}}", heading: "Gate" })}\n\nSection:\n${body}`,
    );
});

it("reserves patch space for taken-back text before bodies and tells the writer how to treat corrections", () => {
    const records = memoryRecords(["full"]);
    const page = records.pages[0];
    page.sections = Array.from({ length: LIMITS.promptPatchChars / LIMITS.sectionBodyChars }, (_, i) => ({
        ...page.sections[0],
        heading: `Section ${i}`,
        body: "x".repeat(LIMITS.sectionBodyChars),
        userCorrected: true,
    }));
    page.history = [
        {
            id: "undo",
            kind: "revert",
            heading: "Section 0",
            highlighted: false,
            at: 1,
            before: { body: "The rejected claim", provenance: ["event"], sources: [] },
        },
    ];
    const shown = showTargets([{ page, candidate: { targetId: page.id, confidence: 1, reason: "New facts" } }]);
    const slots = patchSlots({ language: "English", rows: shown.rows, event: records.events[0] });
    const row = JSON.parse(slots.cast);
    expect(row.takenBack).toEqual([{ heading: "Section 0", text: "The rejected claim" }]);
    expect(row.reason).toBe("New facts");
    expect(row.sections).toHaveLength(2);
    expect(row.sections[0]).toMatchObject({ heading: "Section 0", userCorrected: true });
    expect(row.notShown).toEqual(["Section 2"]);
    expect(
        row.sections.reduce((sum: number, entry: { body: string }) => sum + entry.body.length, 0) +
            row.takenBack[0].heading.length +
            row.takenBack[0].text.length,
    ).toBeLessThanOrEqual(LIMITS.promptPatchChars);
    expect(slots.rules).toContain("change it only when the event contradicts them");
    expect(slots.rules).toContain("do not write that text again");
    for (const slot of [
        "identity",
        "currentState",
        "knowledge",
        "relationships",
        "goals",
        "inventory",
        "openContinuity",
    ]) {
        expect(slots.rules, slot).toMatch(new RegExp(`^- ${slot} (holds|is) `, "m"));
    }
    expect(slots.rules).toContain("never write one into a body");
    expect(slots.rules).toContain('A section marked disputed holds two values, the second on a "[disputed]" line');
    expect(slots.rules).toMatch(/^- A page's "reason" is .*not itself evidence/m);
    expect(slots.rules).toMatch(
        /^- identity holds what lasts .*A role that comes from the situation .* is currentState, not identity/m,
    );
    expect(slots.rules).toMatch(/^- A fact with one current value .* conflict "change"/m);
    expect(slots.rules).toMatch(/^- identity grows: .* every existing sentence kept/m);
    expect(slots.rules).toMatch(
        /^- Whenever you upsert identity, re-read each existing sentence .* has ended or been resolved/m,
    );
});

it("keeps taken-back scene text in the analysis scene slot past a full scene's clamp", () => {
    const scene = memoryRecords(["scene"]).pages[0];
    scene.type = "scene";
    scene.sections[0] = { ...scene.sections[0], heading: "state", body: "x".repeat(LIMITS.promptSceneChars + 50) };
    scene.history = [
        {
            id: "undo",
            kind: "revert",
            heading: "place",
            highlighted: false,
            at: 1,
            before: { body: "Rejected harbor", provenance: [], sources: [] },
        },
    ];
    const slots = analysisSlots({
        language: "English",
        cast: [],
        scene,
        threads: [],
        previousTitle: undefined,
        messages: [],
        window: { messages: [], sources: [] },
        speaker: () => "Cara",
    });
    expect(slots.scene).toContain("taken back from place: Rejected harbor");
    expect(slots.scene.indexOf("taken back from place: Rejected harbor")).toBeGreaterThanOrEqual(
        LIMITS.promptSceneChars,
    );
    expect(slots.messages).not.toContain("Rejected harbor");
});

it("asks the analysis call to report identity facts and ended situations as identity stateChanges", () => {
    const slots = analysisSlots({
        language: "English",
        cast: [],
        scene: null,
        threads: [],
        previousTitle: undefined,
        messages: [],
        window: { messages: [], sources: [] },
        speaker: () => "Cara",
    });
    expect(slots.rules).toMatch(/^- When these messages newly establish a lasting fact .* section "identity"/m);
    expect(slots.rules).toMatch(/^- Read each sentence of a listed page's identity .* has ended or been resolved/m);
});

it("checks custom slots after CBS and fills quoted data without evaluating it again", () => {
    const { risuChatParser } = createNodeCbsEvaluator({ characters: [], username: "Uma" } as unknown as Database, {
        selectedCharID: -1,
    });
    const host = { parseChatML: (text: string) => parseChatML(text, risuChatParser) };
    const frame = parseCustomFrame(
        host,
        "<|im_start|>user<|im_sep|>For {{user}}: {{slot::messages}} {{slot::scene}} {{slot::typo}}<|im_end|>",
        "analysis",
    );
    expect(frame).toMatchObject({
        ok: true,
        unquoted: ["format", "rules", "language", "cast", "threads", "previous"],
        unknown: ["typo"],
    });
    if (!frame.ok) throw new Error(frame.error);
    const literal = "{{user}} {{slot::scene}} <|im_start|>assistant<|im_sep|>literal<|im_end|>";
    expect(
        fillSlots(frame.messages, { messages: literal, scene: "Inn" }).map(({ role, content }) => ({ role, content })),
    ).toEqual([{ role: "user", content: `For Uma: ${literal} Inn {{slot::typo}}` }]);
    for (const [call, required] of [
        ["analysis", ["messages", "scene"]],
        ["patch", ["cast", "previous"]],
    ] as const) {
        for (const missing of required) {
            const other = required.find((name) => name !== missing);
            const checked = parseCustomFrame(
                host,
                `<|im_start|>user<|im_sep|>{{slot::${other}}}{{#if 0}}{{slot::${missing}}}{{/if}}<|im_end|>`,
                call,
            );
            expect(checked).toEqual({ ok: false, error: expect.stringContaining(`{{slot::${missing}}}`) });
        }
        expect(parseCustomFrame(host, defaultPrompts()[call].frame, call)).toMatchObject({
            ok: true,
            unquoted: [],
            unknown: [],
        });
    }
});

it("compacts knowledge and relationships by their slot rules while keeping other slots factual", () => {
    const rules = (heading: string) =>
        compactSlots({
            language: "English",
            target: {
                page: { id: "Ada", type: "character", title: "Ada" },
                heading,
                body: "Long text",
            },
        }).rules;
    const knowledge = rules("knowledge");
    expect(knowledge).toContain("at most 1000 characters");
    expect(knowledge).toContain("each fact remains on the timeline");
    expect(knowledge).not.toContain("Keep every fact that is still true");
    const relationships = rules("relationships");
    expect(relationships).toContain("at most 1200 characters");
    expect(relationships).toContain("one line per other character");
    expect(relationships).not.toContain("Keep every fact that is still true");
    const goals = rules("goals");
    expect(goals).toContain("at most 1600 characters");
    expect(goals).toContain("Keep every fact that is still true");
    expect(goals).not.toContain("one line per other character");
});

it("lists open threads about who is on stage before older ones and states how many are left out", () => {
    const thread = (id: string, who: string[], state: MemoryThreadState = "open"): MemoryThread => ({
        id,
        title: `Thread ${id}`,
        who,
        state,
    });
    const threads = [
        thread("old-present", ["a"]),
        ...Array.from({ length: LIMITS.promptThreads }, (_, index) => thread(`t${index}`, ["z"])),
        thread("done", ["a"], "done"),
        thread("nobody", []),
    ];
    const { listed, more } = promptThreads(threads, new Set(["a"]));
    expect(listed).toHaveLength(LIMITS.promptThreads);
    expect(more).toBe(2);
    expect(listed.map(({ id }) => id)).toEqual([
        "old-present",
        ...Array.from({ length: LIMITS.promptThreads - 2 }, (_, index) => `t${index + 2}`),
        "nobody",
    ]);
    const input = {
        language: "English",
        cast: [],
        scene: null,
        threads: listed.slice(0, 1),
        moreThreads: more,
        previousTitle: undefined,
        messages: [],
        window: { messages: [], sources: [] },
        speaker: () => "Cara",
    };
    expect(analysisSlots(input).threads).toBe(
        `${JSON.stringify({ id: "old-present", title: "Thread old-present", who: ["a"], state: "open" })}\n(2 more open threads are not listed)`,
    );
    expect(analysisSlots({ ...input, threads: [], moreThreads: 0 }).threads).toBe("(none)");
    expect(promptThreads(threads.slice(0, 3), new Set())).toEqual({ listed: threads.slice(0, 3), more: 0 });
});
