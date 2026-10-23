import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatStageOf, dropJobStage, jobStages, resetJobStagesForTests, setJobStage } from "./jobStages";

const chatA = { chaId: "character-a", chatId: "chat-a" };
const chatB = { chaId: "character-b", chatId: "chat-b" };

beforeEach(resetJobStagesForTests);
afterEach(resetJobStagesForTests);

describe("job stages", () => {
    it("keeps different chats' stages at once and updates each job's latest stage", () => {
        setJobStage("job-a", chatA, "preparing");
        setJobStage("job-b", chatB, "generating");
        setJobStage("job-a", chatA, "memory");

        const stages = get(jobStages);
        expect([...stages]).toEqual([
            ["job-a", { chatKey: "character-a\u0000chat-a", stage: "memory" }],
            ["job-b", { chatKey: "character-b\u0000chat-b", stage: "generating" }],
        ]);
        expect(chatStageOf(stages, chatA)).toBe("memory");
        expect(chatStageOf(stages, chatB)).toBe("generating");
    });

    it("uses the job first staged most recently, even after an older job updates or is dropped", () => {
        setJobStage("old", chatA, "preparing");
        setJobStage("new", chatA, "generating");
        setJobStage("old", chatA, "finishing");
        expect(chatStageOf(get(jobStages), chatA)).toBe("generating");

        dropJobStage("old");
        expect([...get(jobStages)]).toEqual([["new", { chatKey: "character-a\u0000chat-a", stage: "generating" }]]);
        expect(chatStageOf(get(jobStages), chatA)).toBe("generating");
    });

    it("returns null for a chat with no staged job, including when another chat has one", () => {
        expect(chatStageOf(get(jobStages), chatA)).toBeNull();
        setJobStage("job-b", chatB, "memory");
        expect(chatStageOf(get(jobStages), chatA)).toBeNull();
    });
});
