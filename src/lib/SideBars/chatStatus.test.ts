import { afterEach, describe, expect, it } from "vitest";
import { changeLanguage, language } from "src/lang";
import {
    CHAT_STATUS_PRIORITY,
    chatStatusLabel,
    collectCharacterStatuses,
    folderStatus,
    resolveChatStatus,
    type ChatStatus,
    type ChatStatusSets,
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
        expect(CHAT_STATUS_PRIORITY).toEqual(["recovery", "generating", "unseen"]);
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
            for (const status of ["recovery", "generating", "unseen"] as const) {
                expect(chatStatusLabel(status, "새벽's chat")).toBe(language.chatStatus[status]("새벽's chat"));
            }
        }
    });
});
