import { expect, it, vi } from "vitest";
import { installFlatDatabaseWithChats } from "../storage/tests/installFlatDatabase";
import { wantsLoreBudgetStop } from "./loreBudgetStop";

vi.mock("../stores.svelte", async () => (await import("../tests/storesMock")).createStoresMock());

it("asks to stop only when the setting is on and the chat has not disabled warnings", () => {
    const ref = { chaId: "c", chatId: "k" };
    for (const [loreBudgetStop, loreBudgetWarnOff, expected] of [
        [false, undefined, false],
        [true, true, false],
        [true, undefined, true],
    ] as const) {
        installFlatDatabaseWithChats({
            loreBudgetStop,
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    chats: [
                        {
                            id: "k",
                            name: "K",
                            note: "",
                            localLore: [],
                            message: [],
                            loreBudgetWarnOff,
                        },
                    ],
                },
            ],
        });
        expect(wantsLoreBudgetStop(ref), JSON.stringify({ loreBudgetStop, loreBudgetWarnOff })).toBe(expected);
    }
});
