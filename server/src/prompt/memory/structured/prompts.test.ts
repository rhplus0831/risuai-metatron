// @vitest-environment node
import { expect, it } from "vitest";
import type { Database } from "../../../../../shared/database.ts";
import { createNodeCbsEvaluator } from "../../../tests/cbsHost.ts";
import { parseChatML } from "../../triggers.ts";
import { STRUCTURED_MEMORY_LIMITS as LIMITS } from "../../../../../shared/structuredMemory.ts";
import { assembleAnalysisPrompt, assembleCompactPrompt, compactSlots, type AnalysisSlots } from "./prompts.ts";

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
