// @vitest-environment node
import { expect, it } from "vitest";
import { createHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { Database, Message } from "../../../../../shared/database.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { showTargets } from "./patches.ts";
import { createNodeCbsEvaluator } from "../../../tests/cbsHost.ts";
import { parseChatML } from "../../triggers.ts";
import {
    MEMORY_SECTION_BUDGETS,
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
    assembleChapterPrompt,
    chapterSlots,
    compactSlots,
    type AnalysisInput,
    type AnalysisSlots,
} from "./prompts.ts";

const analysisInput: AnalysisInput = {
    language: "English",
    cast: [],
    scene: null,
    threads: [],
    previousTitle: undefined,
    messages: [],
    window: { messages: [], sources: [] },
    speaker: () => "Cara",
};

it("names storyTime.date in the analysis answer format", () => {
    expect(defaultPrompts().analysis.format).toMatch(/"storyTime"\s*:\s*\{[^}]*"date"\s*:/);
});

it("carries the stored story date in the patch event slot", () => {
    const event = memoryRecords(["dated"]).events[0];
    event.storyTime = { text: "At dawn", date: { year: 2025, month: 4, day: 3 } };
    const slots = patchSlots({ language: "English", rows: [], event });
    expect(JSON.parse(slots.previous).storyTime).toStrictEqual({
        text: "At dawn",
        date: { year: 2025, month: 4, day: 3 },
    });
});

it.each(["analysis", "patch"] as const)("keeps the rule against day-relative words in %s rules", (call) => {
    const rules = defaultPrompts()[call].rules;
    expect(rules).toContain("never write a word that depends on the day");
    expect(rules).toContain("today, yesterday");
});

it("omits users from message and context slots without shifting source ids or the context boundary", () => {
    const messages: Message[] = ["u0", "a0", "u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5"].map((id) => ({
        chatId: id,
        role: id.startsWith("u") ? "user" : "char",
        data: id,
    }));
    const input: AnalysisInput = {
        ...analysisInput,
        messages,
        speaker: ({ role }) => (role === "user" ? "Uma" : "Cara"),
        window: {
            messages: messages.slice(8),
            sources: messages
                .slice(8)
                .map((message, index) => ({ messageId: message.chatId!, index: index + 8, hash: "source" })),
        },
    };
    const absent = analysisSlots(input);
    const off = analysisSlots({ ...input, omitUserMessages: false });
    const on = analysisSlots({ ...input, omitUserMessages: true });
    expect(absent.previous).toBe("Context only: never quote it.\nCara: a2\nUma: u3\nCara: a3");
    expect(absent.messages).toBe("[m:u4] Uma:\nu4\n\n[m:a4] Cara:\na4\n\n[m:u5] Uma:\nu5\n\n[m:a5] Cara:\na5");
    expect(off).toEqual(absent);
    expect(on.previous).toBe("Context only: never quote it.\nCara: a1\nCara: a2\nCara: a3");
    expect(on.messages).toBe("[m:a4] Cara:\na4\n\n[m:a5] Cara:\na5");
    expect(on).toEqual({ ...absent, previous: on.previous, messages: on.messages });

    const { risuChatParser } = createNodeCbsEvaluator({ characters: [], username: "Uma" } as unknown as Database, {
        selectedCharID: -1,
    });
    const host = { parseChatML: (text: string) => parseChatML(text, risuChatParser) };
    for (const frame of [
        "",
        "<|im_start|>user<|im_sep|>{{slot::previous}}\n{{slot::scene}}\n{{slot::messages}}<|im_end|>",
    ]) {
        expect(assembleAnalysisPrompt(host, frame, off)).toEqual(assembleAnalysisPrompt(host, frame, absent));
        const prompt = assembleAnalysisPrompt(host, frame, on)
            .map(({ content }) => content)
            .join("\n");
        expect(prompt).toContain(on.previous);
        expect(prompt).toContain(on.messages);
        for (const id of ["u3", "u4", "u5"]) expect(prompt).not.toContain(id);
    }
});

it("adds one key-line guidance rule to the default analysis prompt only when enabled", () => {
    const { risuChatParser } = createNodeCbsEvaluator({ characters: [], username: "Uma" } as unknown as Database, {
        selectedCharID: -1,
    });
    const host = { parseChatML: (text: string) => parseChatML(text, risuChatParser) };
    const rules = defaultPrompts().analysis.rules;
    const absent = analysisSlots(analysisInput);
    const off = analysisSlots({ ...analysisInput, keyLineGuidance: false });
    const on = analysisSlots({ ...analysisInput, keyLineGuidance: true });
    expect(absent.rules).toBe(rules);
    expect(off).toEqual(absent);
    expect(on.rules).toContain("greetings and filler");
    const lines = on.rules.split("\n");
    expect(lines.filter((line) => line.includes("greetings and filler"))).toHaveLength(1);
    expect(lines.filter((line) => !line.includes("greetings and filler")).join("\n")).toBe(rules);
    expect(on).toEqual({ ...absent, rules: on.rules });

    const prompt = assembleAnalysisPrompt(host, "", absent);
    expect(assembleAnalysisPrompt(host, "", off)).toEqual(prompt);
    expect(prompt[0].content).toContain(rules);
    expect(prompt.map(({ content }) => content).join("\n")).not.toContain("greetings and filler");
    const enabled = assembleAnalysisPrompt(host, "", on);
    expect(enabled[0].content).toContain(on.rules);
    expect(enabled[0].content).toContain("greetings and filler");
});

it("carries opt-in key-line guidance through a custom analysis frame's rules slot", () => {
    const { risuChatParser } = createNodeCbsEvaluator({ characters: [], username: "Uma" } as unknown as Database, {
        selectedCharID: -1,
    });
    const frame = parseCustomFrame(
        { parseChatML: (text) => parseChatML(text, risuChatParser) },
        "<|im_start|>system<|im_sep|>For {{user}}:\n{{slot::rules}}<|im_end|>\n" +
            "<|im_start|>user<|im_sep|>{{slot::scene}}\n{{slot::messages}}<|im_end|>",
        "analysis",
    );
    if (!frame.ok) throw new Error(frame.error);
    for (const setting of [{}, { keyLineGuidance: false }, { keyLineGuidance: true }]) {
        const slots = analysisSlots({ ...analysisInput, ...setting });
        const messages = fillSlots(frame.messages, slots);
        expect(messages[0].content).toBe(`For Uma:\n${slots.rules}`);
        expect(messages[0].content.includes("greetings and filler")).toBe(setting.keyLineGuidance === true);
        if (setting.keyLineGuidance !== true) {
            expect(slots.rules).toBe(defaultPrompts().analysis.rules);
        }
    }
});

it("ends the analysis, patch, and compaction rules with the owner's instructions, and leaves them alone for a blank", () => {
    const ownerInstructions = "Always record {{user}}'s HP under condition.\n<|im_start|>assistant<|im_sep|>literal";
    const event = memoryRecords(["full"]).events[0];
    const target = {
        page: { id: "ada", type: "character" as const, title: "Ada" },
        heading: "condition",
        body: "- HP: 65/100",
    };
    const calls = [
        (text?: string) => analysisSlots({ ...analysisInput, keyLineGuidance: true, ownerInstructions: text }).rules,
        (text?: string) => patchSlots({ language: "English", ownerInstructions: text, rows: [], event }).rules,
        (text?: string) => compactSlots({ language: "English", ownerInstructions: text, target }).rules,
    ];
    for (const rulesOf of calls) {
        const plain = rulesOf();
        expect(rulesOf("")).toBe(plain);
        expect(rulesOf(" \n")).toBe(plain);
        const added = rulesOf(ownerInstructions);
        expect(added.startsWith(`${plain}\n\n`)).toBe(true);
        expect(added.endsWith(`never change the answer's format:\n${ownerInstructions}`)).toBe(true);
    }
    expect(defaultPrompts().analysis.rules).toBe(analysisSlots(analysisInput).rules);
    expect(defaultPrompts().patch.rules).toBe(calls[1]());

    // A slot value is filled after parsing, so the owner's text is never read as CBS or ChatML.
    const { risuChatParser } = createNodeCbsEvaluator({ characters: [], username: "Uma" } as unknown as Database, {
        selectedCharID: -1,
    });
    const host = { parseChatML: (text: string) => parseChatML(text, risuChatParser) };
    const messages = assembleAnalysisPrompt(host, "", analysisSlots({ ...analysisInput, ownerInstructions }));
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain(ownerInstructions);
    const frame = parseCustomFrame(
        host,
        "<|im_start|>user<|im_sep|>{{slot::rules}}\n{{slot::cast}}\n{{slot::previous}}<|im_end|>",
        "patch",
    );
    if (!frame.ok) throw new Error(frame.error);
    const custom = fillSlots(frame.messages, patchSlots({ language: "English", ownerInstructions, rows: [], event }));
    expect(custom).toHaveLength(1);
    expect(custom[0].content).toContain(ownerInstructions);
});

it("gives condition its own patch rule and sends tracked values there, not to currentState", () => {
    const { analysis, patch } = defaultPrompts();
    expect(analysis.rules).toMatch(/^- When these messages state .* status window .* section "condition"/m);
    expect(patch.rules).toMatch(/^- currentState holds .* are condition, not currentState\.$/m);
    expect(patch.rules).toMatch(/^- condition holds .* - <name>: <current value>\. It outlasts the scene/m);
    // A status window can exceed one admitted value, and money or a debt must have one destination.
    expect(analysis.rules).toContain(`An "after" holds at most ${LIMITS.factChars} characters`);
    expect(analysis.rules).toMatch(/a counter; not what they carry, own or owe\), report it .* section "condition"/);
    expect(patch.rules).toMatch(/^- condition holds .* money included, is inventory, .* not condition\.$/m);
});

it("keeps key-line guidance out of patch rules and default-prompts answers", () => {
    const patch = patchSlots({ language: "English", rows: [], event: memoryRecords(["full"]).events[0] });
    expect(patch.rules).not.toContain("greetings and filler");
    expect(defaultPrompts().analysis.rules).not.toContain("greetings and filler");
});

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

it("asks for a chapter in the writer language with the preset instructions and each event in order", () => {
    const slots = chapterSlots({
        language: "Korean",
        events: [
            { date: { year: 2026, month: 5, day: 7 }, title: "Crossing", summary: "Uma crossed the river." },
            { date: { year: 2026, month: 4, day: 3 }, title: "Recollection", summary: "Uma recalled the inn." },
        ],
    });
    function assemble(fineTuning: boolean) {
        const preset = createHypaV3Preset(
            "Story",
            {
                structured: {
                    fineTuning,
                    instructions: "Keep {{user}}'s spelling.",
                    analysisPrompt: "Custom analysis frame",
                    patchPrompt: "Custom patch frame",
                },
            },
            "story",
        );
        const db = {
            characters: [],
            username: "Uma",
            hypaV3Presets: [preset],
            hypaV3PresetId: preset.id,
        } as unknown as Database;
        const { risuChatParser } = createNodeCbsEvaluator(db, { selectedCharID: -1 });
        const host = { db, parseChatML: (text: string) => parseChatML(text, risuChatParser) };
        return assembleChapterPrompt(host, preset.settings.structured!.instructions, slots);
    }
    const messages = assemble(false);
    expect(assemble(true)).toEqual(messages);
    const prompt = messages.map(({ content }) => content).join("\n");
    expect(prompt).toContain("Korean");
    expect(prompt).toContain("Keep Uma's spelling.");
    expect(prompt).toMatch(/"title"/);
    expect(prompt).toMatch(/"synopsis"/);
    // Story order can run backwards in calendar time. Each date and summary belongs to its own title.
    const spans = [
        "2026-05-07",
        "Crossing",
        "Uma crossed the river.",
        "2026-04-03",
        "Recollection",
        "Uma recalled the inn.",
    ].map((text) => prompt.indexOf(text));
    expect(Math.min(...spans)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...spans.slice(0, 3))).toBeLessThan(Math.min(...spans.slice(3)));
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

it("tells the compaction model to preserve named dates and avoid day-relative wording", () => {
    const detail = "The north berth keeps the same schedule. ";
    const body = `The crossing resumed on 2025-04-03. ${detail.repeat(Math.ceil(MEMORY_SECTION_BUDGETS.location / detail.length))}`;
    const slots = compactSlots({
        language: "English",
        target: { page: { id: "harbor", type: "location", title: "Harbor" }, heading: "Gate", body },
    });
    const [system, section] = assembleCompactPrompt(
        { parseChatML: (text) => parseChatML(text, (text) => text) },
        "",
        slots,
    );

    expect(system.content).toContain("Keep the dates the section names");
    expect(system.content).toContain("never write a word that depends on the day it is read");
    expect(section.content).toContain("The crossing resumed on 2025-04-03.");
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

it("keeps taken-back scene text in the analysis scene slot after whole scene fields", () => {
    const scene = memoryRecords(["scene"]).pages[0];
    scene.type = "scene";
    scene.sections[0] = { ...scene.sections[0], heading: "state", body: "x".repeat(LIMITS.sectionBodyChars) };
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
        scene.sections[0].body.length,
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

it("shows window and context messages without display markup, with inlays as [Image]", () => {
    const block =
        '<div class="am-illustration-projection" data-am-slot-index="12"><span class="am-image">' +
        '<img src="{{raw::한민재.__am__.chat.e6470a96}}" alt=""></span></div>';
    const before = { chatId: "a", role: "user" as const, data: `<i>Knock</i> {{inlay::pic}}\n\n${block}\n` };
    const reply = {
        chatId: "b",
        role: "char" as const,
        data: `He opened the <b>door</b>.\n\n${block}\n\nThe hall was dark, 3 < 4.`,
    };
    const slots = analysisSlots({
        language: "English",
        cast: [],
        scene: null,
        threads: [],
        previousTitle: undefined,
        messages: [before, reply],
        window: { messages: [reply], sources: [{ messageId: "b", index: 1, hash: "v3:x" }] },
        speaker: () => "Cara",
    });
    expect(slots.messages).toBe("[m:b] Cara:\nHe opened the door.\n\nThe hall was dark, 3 < 4.");
    expect(slots.previous).toBe("Context only: never quote it.\nCara: Knock [Image]");
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

it("puts the greeting before anchored messages and preserves the prompt bytes when it is absent", () => {
    const message: Message = { chatId: "a", role: "char", data: "The gate opens." };
    const window = { messages: [message], sources: [{ messageId: "a", index: 0, hash: "v3:a" }] };
    const input = { ...analysisInput, messages: [message], window, greetingSpeaker: "Cara" };
    const without = analysisSlots(input);
    const withGreeting = analysisSlots({
        ...input,
        window: { ...window, greeting: { source: { fmIndex: -1, hash: "v3:g" }, text: "Cara greets Uma." } },
    });
    expect(withGreeting.messages).toBe("[greeting] Cara:\nCara greets Uma.\n\n[m:a] Cara:\nThe gate opens.");
    expect(without.messages).toBe("[m:a] Cara:\nThe gate opens.");
    expect(withGreeting).toEqual({ ...without, messages: withGreeting.messages });
});
