import { afterEach, describe, expect, it } from "vitest";
import { changeLanguage, language } from "src/lang";
import {
    CHAT_STATUS_PRIORITY,
    chatStatusLabel,
    collectCharacterStatuses,
    collectMemoryProgress,
    folderStatus,
    groupMemoryCount,
    memoryCountText,
    resolveChatStatus,
    type ChatStatus,
    type ChatStatusSets,
    type MemoryCount,
} from "./chatStatus";

afterEach(() => changeLanguage("en"));

describe("sidebar chat statuses", () => {
    it("resolves only the requested chat, with recovery before generating before unseen", () => {
        const recoveryKeys = ["a\u0000all", "a\u0000recovery-generating", "a\u0000recovery-unseen", "a\u0000recovery"];
        const sets: ChatStatusSets = {
            recovery: new Map(recoveryKeys.map((key) => [key, "lost-job"])),
            generating: new Set([
                "a\u0000all",
                "a\u0000recovery-generating",
                "a\u0000generating-unseen",
                "a\u0000shared",
            ]),
            unseen: new Set(["a\u0000all", "a\u0000recovery-unseen", "a\u0000generating-unseen", "b\u0000shared"]),
        };
        const keys = [
            "a\u0000all",
            "a\u0000recovery-generating",
            "a\u0000recovery-unseen",
            "a\u0000recovery",
            "a\u0000generating-unseen",
            "a\u0000shared",
            "b\u0000shared",
            "a\u0000idle",
        ];

        // Recovery sources may be either a set of keys or a map from key to job.
        for (const recovery of [sets.recovery, new Set(recoveryKeys)]) {
            expect(keys.map((key) => resolveChatStatus({ ...sets, recovery }, key))).toEqual([
                "recovery",
                "recovery",
                "recovery",
                "recovery",
                "generating",
                "generating",
                "unseen",
                null,
            ]);
        }
        expect(CHAT_STATUS_PRIORITY).toEqual(["recovery", "generating", "memory", "unseen"]);
        expect(
            resolveChatStatus({ recovery: new Set(), generating: new Set(), unseen: new Set() }, keys[0]),
        ).toBeNull();
    });

    it("aggregates mixed chat keys into the highest status for each character", () => {
        const sets: ChatStatusSets = {
            recovery: new Map([
                ["a\u0000lost", "job-a"],
                ["d\u0000shared", "job-d"],
            ]),
            generating: new Set(["b\u0000working", "a\u0000another", "b\u0000second"]),
            unseen: new Set(["a\u0000shared", "b\u0000shared", "c\u0000shared", "c\u0000second"]),
        };

        expect(collectCharacterStatuses(sets)).toEqual(
            new Map<string, ChatStatus>([
                ["a", "recovery"],
                ["b", "generating"],
                ["c", "unseen"],
                ["d", "recovery"],
            ]),
        );
        expect(collectCharacterStatuses({ recovery: new Set(), generating: new Set(), unseen: new Set() })).toEqual(
            new Map(),
        );
    });

    it("uses the highest status of folder members, ignoring idle members and characters outside the folder", () => {
        const statuses = new Map<string, ChatStatus>([
            ["lost", "recovery"],
            ["working", "generating"],
            ["new", "unseen"],
            ["outside", "recovery"],
        ]);

        expect(folderStatus(statuses, ["idle", "new", "working", "lost"])).toBe("recovery");
        expect(folderStatus(statuses, ["lost", "working", "new", "idle"])).toBe("recovery");
        expect(folderStatus(statuses, ["idle", "new", "working"])).toBe("generating");
        expect(folderStatus(statuses, ["idle", "new"])).toBe("unseen");
        expect(folderStatus(statuses, ["idle"])).toBeNull();
        expect(folderStatus(statuses, [])).toBeNull();
    });

    it("gets each status label and its supplied name from the current language", () => {
        for (const locale of ["en", "ko"]) {
            changeLanguage(locale);
            for (const status of ["recovery", "generating", "memory", "unseen"] as const) {
                expect(chatStatusLabel(status, "새벽's chat")).toBe(language.chatStatus[status]("새벽's chat"));
            }
            // A memory label carries the count when there is one; a count with another status is ignored.
            expect(chatStatusLabel("memory", "새벽's chat", { done: 2, total: 5 })).toBe(
                language.chatStatus.memory("새벽's chat", "2/5"),
            );
            expect(chatStatusLabel("memory", "새벽's chat", { done: 2, total: 5 })).toContain("2/5");
            expect(chatStatusLabel("generating", "새벽's chat", { done: 2, total: 5 })).toBe(
                language.chatStatus.generating("새벽's chat"),
            );
        }
    });

    it("places a summarizing chat after generating and before unseen, with or without the memory set", () => {
        const memory = new Map<string, MemoryCount | null>([
            ["a\u0000summarizing", { done: 1, total: 3 }],
            ["a\u0000generating-memory", null],
            ["a\u0000memory-unseen", null],
        ]);
        const sets: ChatStatusSets = {
            recovery: new Set(),
            generating: new Set(["a\u0000generating-memory"]),
            memory,
            unseen: new Set(["a\u0000memory-unseen", "b\u0000unseen"]),
        };
        const keys = ["a\u0000summarizing", "a\u0000generating-memory", "a\u0000memory-unseen", "b\u0000unseen"];
        expect(keys.map((key) => resolveChatStatus(sets, key))).toEqual(["memory", "generating", "memory", "unseen"]);
        expect(collectCharacterStatuses(sets)).toEqual(
            new Map<string, ChatStatus>([
                ["a", "generating"],
                ["b", "unseen"],
            ]),
        );
        expect(collectCharacterStatuses({ ...sets, generating: new Set() })).toEqual(
            new Map<string, ChatStatus>([
                ["a", "memory"],
                ["b", "unseen"],
            ]),
        );
        // Callers without a memory set (the set is optional) resolve as before.
        const { memory: _memory, ...without } = sets;
        expect(keys.map((key) => resolveChatStatus(without, key))).toEqual([null, "generating", "unseen", "unseen"]);
        expect(collectCharacterStatuses(without)).toEqual(
            new Map<string, ChatStatus>([
                ["a", "generating"],
                ["b", "unseen"],
            ]),
        );
    });

    it("shows a count only for the one summarizing chat of a character or folder", () => {
        const progress = collectMemoryProgress(
            new Map<string, MemoryCount | null>([
                ["a\u0000one", { done: 2, total: 5 }],
                ["b\u0000first", { done: 1, total: 2 }],
                ["b\u0000second", null],
                ["c\u0000queued", null],
            ]),
        );
        expect(progress).toEqual(
            new Map([
                ["a", { chats: 1, count: { done: 2, total: 5 } }],
                ["b", { chats: 2, count: { done: 1, total: 2 } }],
                ["c", { chats: 1, count: null }],
            ]),
        );
        expect(groupMemoryCount(progress, ["a"])).toEqual({ done: 2, total: 5 });
        // Several summarizing chats in one character, or across a folder: the status without a count.
        expect(groupMemoryCount(progress, ["b"])).toBeNull();
        expect(groupMemoryCount(progress, ["a", "c"])).toBeNull();
        expect(groupMemoryCount(progress, ["idle", "a", "idle2"])).toEqual({ done: 2, total: 5 });
        // One queued (no count yet), or none summarizing.
        expect(groupMemoryCount(progress, ["c"])).toBeNull();
        expect(groupMemoryCount(progress, ["idle"])).toBeNull();
        expect(groupMemoryCount(progress, [])).toBeNull();
        expect(memoryCountText({ done: 2, total: 5 })).toBe("2/5");
    });
});
