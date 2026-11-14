import { describe, expect, it } from "vitest";
import {
    defaultInputHooks,
    draftHookOf,
    inputHookHistoryCounts,
    inputHookMessages,
    normalizeInputHooks,
    type InputHook,
} from "../inputHooks.ts";
import type { TranslatorHistory } from "../translation/historySlots.ts";

const draft: InputHook = {
    id: "draft",
    name: "Polish",
    type: "draft",
    prompt: "Polish {{slot::content}}",
    model: { mode: "inherit" },
};

describe("normalizeInputHooks", () => {
    it("defaults a non-list to the English Draft hook and preserves an empty list", () => {
        const expected = [
            {
                id: "default-translate",
                name: "Translate",
                type: "draft",
                prompt: "Translate the following user message into English. Preserve names, commands, markdown, and inlay tags. Output only the translated message.",
                model: { mode: "inherit" },
            },
        ];
        expect(defaultInputHooks()).toEqual(expected);
        for (const value of [undefined, null, {}, "hooks", 7]) {
            expect(normalizeInputHooks(value)).toEqual(expected);
        }
        expect(normalizeInputHooks([])).toEqual([]);
    });

    it("keeps valid hooks in order, drops duplicate ids, and normalizes translation and model fields", () => {
        expect(
            normalizeInputHooks([
                { ...draft, translation: true, extra: "discard", model: { mode: "profile", profileId: "profile-1" } },
                { ...draft, name: "Duplicate" },
                { ...draft, id: "malformed", prompt: 7 },
                { ...draft, id: "btw", type: "btw", translation: true, model: { mode: "profile", profileId: 7 } },
                { ...draft, id: "false", translation: false },
                { ...draft, id: "truthy", translation: "true" },
            ]),
        ).toEqual([
            { ...draft, translation: true, model: { mode: "profile", profileId: "profile-1" } },
            { ...draft, id: "btw", type: "btw" },
            { ...draft, id: "false" },
            { ...draft, id: "truthy" },
        ]);
    });

    it("limits the list to 50 kept hooks without charging malformed entries or duplicate ids", () => {
        const hooks = Array.from({ length: 51 }, (_, index) => ({ ...draft, id: `hook-${index}` }));
        const entries = hooks.flatMap((hook) => [
            null,
            { ...hook, type: "unknown" },
            hook,
            { ...hook, name: "Duplicate" },
        ]);
        expect(normalizeInputHooks(entries)).toEqual(hooks.slice(0, 50));
    });
});

it("finds only a Draft hook with a valid matching id", () => {
    const hooks: InputHook[] = [draft, { ...draft, id: "btw", type: "btw" }];
    expect(draftHookOf(hooks, "draft")).toEqual(draft);
    for (const id of [undefined, null, "missing", "btw", "", "  ", 7, { id: "draft" }]) {
        expect(draftHookOf(hooks, id)).toBeNull();
    }
});

it("counts each valid history size once and ignores invalid counts and nested slots", () => {
    expect(
        inputHookHistoryCounts(
            "{{slot::history::2}} {{slot::historytrans::2}} {{slot::history::2}} " +
                "{{slot::historytrans::1}} {{slot::history::0}} {{slot::historytrans::51}} " +
                "{{slot::history::nope}} {{unknown::{{slot::history::3}}}} {{slot::history::50}}",
        ),
    ).toEqual([2, 1, 50]);
});

describe("inputHookMessages", () => {
    it("fills all four slots once into one user row and leaves unknown placeholders alone", () => {
        const history: TranslatorHistory = (slot, count) =>
            count === 2
                ? { history: "user: earlier {{slot::content}}", historytrans: "user: translated {{slot::draft}}" }[slot]
                : "";
        expect(
            inputHookMessages(
                {
                    prompt:
                        "Content: {{slot::content}}\nDraft: {{slot::draft}}\n" +
                        "History: {{slot::history::2}}\nTranslated: {{slot::historytrans::2}}\n" +
                        "{{unknown::{{slot::history::2}}}} {{unknown}}",
                },
                { content: "typed {{slot::draft}}", draft: "draft {{slot::history::2}}" },
                history,
            ),
        ).toEqual([
            {
                role: "user",
                content:
                    "Content: typed {{slot::draft}}\nDraft: draft {{slot::history::2}}\n" +
                    "History: user: earlier {{slot::content}}\nTranslated: user: translated {{slot::draft}}\n" +
                    "{{unknown::{{slot::history::2}}}} {{unknown}}",
            },
        ]);
    });

    it("parses a filled ChatML prompt into its system, user, and assistant rows", () => {
        expect(
            inputHookMessages(
                {
                    prompt:
                        "<|im_start|>system<|im_sep|>Translate.<|im_end|>" +
                        "<|im_start|>user<|im_sep|>{{slot::content}}<|im_end|>" +
                        "<|im_start|>assistant<|im_sep|>{{slot::draft}}<|im_end|>",
                },
                { content: "Bonjour", draft: "Hello" },
            ),
        ).toEqual([
            { role: "system", content: "Translate." },
            { role: "user", content: "Bonjour" },
            { role: "assistant", content: "Hello" },
        ]);
    });

    it("sends a slotless prompt as a system row followed by the composer's content", () => {
        expect(
            inputHookMessages({ prompt: "Translate. Keep {{unknown}}." }, { content: "Bonjour", draft: "unused" }),
        ).toEqual([
            { role: "system", content: "Translate. Keep {{unknown}}." },
            { role: "user", content: "Bonjour" },
        ]);
    });

    it("fills missing history and invalid history counts with empty text while retaining a user row", () => {
        const values = { content: "unused", draft: "unused" };
        expect(inputHookMessages({ prompt: "[{{slot::history::1}}][{{slot::historytrans::2}}]" }, values)).toEqual([
            { role: "user", content: "[][]" },
        ]);
        expect(
            inputHookMessages(
                { prompt: "[{{slot::history::0}}][{{slot::historytrans::51}}][{{slot::history::nope}}]" },
                values,
                () => "must not be inserted",
            ),
        ).toEqual([{ role: "user", content: "[][][]" }]);
    });
});
