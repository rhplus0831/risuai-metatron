// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
    DEFAULT_NEW_CHAT_BINDING,
    isNewChatBinding,
    NEW_CHAT_BINDING_VALUES,
    readChatBindingIds,
    resolveChatBinding,
    type ChatBindingFields,
    type ChatBindingLookup,
} from "../chatBinding.ts";

// The pure resolver both sides run before a send. It fails closed: every field must name a record
// that exists and no confirmation may be pending; every problem is reported at once, in field
// order; there is no fallback branch, so a lookup that answers "exists" for everything still cannot
// make an unset field pass.

/** A lookup over fixed id sets, each call recorded. */
function lookupOf(sets: { modelPreset?: string[]; promptPreset?: string[]; persona?: string[] }) {
    const calls: [keyof ChatBindingLookup, string][] = [];
    const over = (kind: keyof ChatBindingLookup) => (id: string) => {
        calls.push([kind, id]);
        return (sets[kind] ?? []).includes(id);
    };
    const lookup: ChatBindingLookup = {
        modelPreset: over("modelPreset"),
        promptPreset: over("promptPreset"),
        persona: over("persona"),
    };
    return { lookup, calls };
}

const everything: ChatBindingLookup = { modelPreset: () => true, promptPreset: () => true, persona: () => true };
const nothing: ChatBindingLookup = { modelPreset: () => false, promptPreset: () => false, persona: () => false };

const bound: ChatBindingFields = { modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" };

describe("the new-chat setting", () => {
    it("has the two values with `inherit` as the default, and the guard accepts nothing else", () => {
        expect(NEW_CHAT_BINDING_VALUES).toEqual(["inherit", "empty"]);
        expect(DEFAULT_NEW_CHAT_BINDING).toBe("inherit");
        expect(isNewChatBinding("inherit")).toBe(true);
        expect(isNewChatBinding("empty")).toBe(true);
        for (const value of ["", "Inherit", "tab", "selection", 0, 1, true, null, undefined, {}, ["inherit"]]) {
            expect(isNewChatBinding(value), JSON.stringify(value)).toBe(false);
        }
    });
});

describe("readChatBindingIds", () => {
    it("reads the three ids as stored (the persona from `bindedPersona`), null when absent, and review only when it is exactly true", () => {
        expect(readChatBindingIds({})).toEqual({
            modelPresetId: null,
            promptPresetId: null,
            personaId: null,
            review: false,
        });
        expect(readChatBindingIds({ ...bound, bindingReview: true })).toEqual({
            modelPresetId: "m1",
            promptPresetId: "p1",
            personaId: "u1",
            review: true,
        });
        expect(readChatBindingIds({ ...bound, bindingReview: false }).review).toBe(false);
        for (const value of ["true", 1, {}, null] as unknown[]) {
            expect(readChatBindingIds({ bindingReview: value as boolean }).review, JSON.stringify(value)).toBe(false);
        }
    });

    it("treats a blank or whitespace-only id and a non-string as unset, and keeps any other string unchanged, padding included", () => {
        for (const blank of ["", " ", "\t\n ", " "]) {
            expect(readChatBindingIds({ modelPresetId: blank }).modelPresetId, JSON.stringify(blank)).toBeNull();
            expect(readChatBindingIds({ promptPresetId: blank }).promptPresetId, JSON.stringify(blank)).toBeNull();
            expect(readChatBindingIds({ bindedPersona: blank }).personaId, JSON.stringify(blank)).toBeNull();
        }
        for (const value of [0, 1, true, {}, [], null] as unknown[]) {
            const chat = { modelPresetId: value, promptPresetId: value, bindedPersona: value } as ChatBindingFields;
            expect(readChatBindingIds(chat), JSON.stringify(value)).toMatchObject({
                modelPresetId: null,
                promptPresetId: null,
                personaId: null,
            });
        }
        // Not trimmed: the stored id is the id.
        expect(readChatBindingIds({ modelPresetId: " m1 ", promptPresetId: "p 1", bindedPersona: "u1\n" })).toEqual({
            modelPresetId: " m1 ",
            promptPresetId: "p 1",
            personaId: "u1\n",
            review: false,
        });
    });
});

describe("resolveChatBinding", () => {
    it("is ok, with the chat's own ids, when every field names a record that exists and no review is pending", () => {
        const { lookup, calls } = lookupOf({ modelPreset: ["m1"], promptPreset: ["p1"], persona: ["u1"] });
        const result = resolveChatBinding(bound, lookup);
        expect(result).toEqual({ ok: true, ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" } });
        expect(result).not.toHaveProperty("problems");
        expect(calls).toEqual([
            ["modelPreset", "m1"],
            ["promptPreset", "p1"],
            ["persona", "u1"],
        ]);
        // `bindingReview: false` is no review.
        expect(resolveChatBinding({ ...bound, bindingReview: false }, lookup).ok).toBe(true);
    });

    it("passes a padded id to the lookup and returns it unchanged", () => {
        const padded = { modelPresetId: " m1 ", promptPresetId: "p1", bindedPersona: "u1" };
        const { lookup, calls } = lookupOf({ modelPreset: [" m1 "], promptPreset: ["p1"], persona: ["u1"] });
        expect(resolveChatBinding(padded, lookup)).toEqual({
            ok: true,
            ids: { modelPresetId: " m1 ", promptPresetId: "p1", personaId: "u1" },
        });
        expect(calls[0]).toEqual(["modelPreset", " m1 "]);
        // The trimmed id is not the stored one: a lookup that knows only `m1` says gone.
        const strict = lookupOf({ modelPreset: ["m1"], promptPreset: ["p1"], persona: ["u1"] });
        expect(resolveChatBinding(padded, strict.lookup)).toEqual({
            ok: false,
            problems: [{ field: "modelPresetId", reason: "gone" }],
        });
    });

    it("reports each problem kind on its own: an unset field, a gone record, a pending review", () => {
        const { lookup } = lookupOf({ modelPreset: ["m1"], promptPreset: ["p1"], persona: ["u1"] });
        expect(resolveChatBinding({ ...bound, modelPresetId: undefined }, lookup)).toEqual({
            ok: false,
            problems: [{ field: "modelPresetId", reason: "unset" }],
        });
        expect(resolveChatBinding({ ...bound, promptPresetId: "" }, lookup)).toEqual({
            ok: false,
            problems: [{ field: "promptPresetId", reason: "unset" }],
        });
        expect(resolveChatBinding({ ...bound, bindedPersona: "   " }, lookup)).toEqual({
            ok: false,
            problems: [{ field: "personaId", reason: "unset" }],
        });
        expect(resolveChatBinding({ ...bound, modelPresetId: "m9" }, lookup)).toEqual({
            ok: false,
            problems: [{ field: "modelPresetId", reason: "gone" }],
        });
        expect(resolveChatBinding({ ...bound, promptPresetId: "p9" }, lookup)).toEqual({
            ok: false,
            problems: [{ field: "promptPresetId", reason: "gone" }],
        });
        expect(resolveChatBinding({ ...bound, bindedPersona: "u9" }, lookup)).toEqual({
            ok: false,
            problems: [{ field: "personaId", reason: "gone" }],
        });
        const review = resolveChatBinding({ ...bound, bindingReview: true }, lookup);
        expect(review).toEqual({ ok: false, problems: [{ field: "review" }] });
        expect(review).not.toHaveProperty("ids");
    });

    it("reports every problem at once, in field order with the review last, and the raw ids stay readable beside them", () => {
        const chat: ChatBindingFields = {
            promptPresetId: "p-gone",
            bindedPersona: " ",
            bindingReview: true,
        };
        const { lookup, calls } = lookupOf({ promptPreset: ["p1"] });
        expect(resolveChatBinding(chat, lookup)).toEqual({
            ok: false,
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "promptPresetId", reason: "gone" },
                { field: "personaId", reason: "unset" },
                { field: "review" },
            ],
        });
        // An unset field asks the lookup nothing.
        expect(calls).toEqual([["promptPreset", "p-gone"]]);
        expect(readChatBindingIds(chat)).toEqual({
            modelPresetId: null,
            promptPresetId: "p-gone",
            personaId: null,
            review: true,
        });
        // Three gone records and a review: four problems, same order.
        expect(resolveChatBinding({ ...bound, bindingReview: true }, nothing)).toEqual({
            ok: false,
            problems: [
                { field: "modelPresetId", reason: "gone" },
                { field: "promptPresetId", reason: "gone" },
                { field: "personaId", reason: "gone" },
                { field: "review" },
            ],
        });
    });

    it("has no fallback: an empty chat blocks even when every record exists, and the lookup is never asked for an id the chat does not hold", () => {
        const modelPreset = vi.fn(() => true);
        const promptPreset = vi.fn(() => true);
        const persona = vi.fn(() => true);
        expect(resolveChatBinding({}, { modelPreset, promptPreset, persona })).toEqual({
            ok: false,
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "promptPresetId", reason: "unset" },
                { field: "personaId", reason: "unset" },
            ],
        });
        expect(modelPreset).not.toHaveBeenCalled();
        expect(promptPreset).not.toHaveBeenCalled();
        expect(persona).not.toHaveBeenCalled();
        expect(resolveChatBinding({ bindedPersona: "u1" }, everything)).toEqual({
            ok: false,
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "promptPresetId", reason: "unset" },
            ],
        });
    });

    it("reads the chat's own fields only: nothing else on the object counts, and the input is not changed", () => {
        const chat = Object.freeze({
            ...bound,
            personaId: "u9",
            selectedPersona: 3,
            bindingReview: false,
        }) as ChatBindingFields;
        expect(resolveChatBinding(chat, everything)).toEqual({
            ok: true,
            ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" },
        });
        expect(chat).toEqual({ ...bound, personaId: "u9", selectedPersona: 3, bindingReview: false });
    });
});
