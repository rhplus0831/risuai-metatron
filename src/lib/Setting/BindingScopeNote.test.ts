// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBindingField } from "../../../shared/chatBinding.ts";

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { changeLanguage } from "src/lang";
import { chatBindingIds, chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import { selectChat } from "src/ts/storage/chatStore.svelte";
import {
    selection,
    selectCharacter,
    selectPreset,
    selectModelPreset,
    selectPersona,
} from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import BindingScopeNote from "./BindingScopeNote.svelte";

const ref = { chaId: "c", chatId: "chat" };
const binding = { promptPresetId: "p2", modelPresetId: "m2", personaId: "u2" };
const fields = [
    { field: "promptPresetId", selectionKey: "presetId", boundId: "p2" },
    { field: "modelPresetId", selectionKey: "modelPresetId", boundId: "m2" },
    { field: "personaId", selectionKey: "personaId", boundId: "u2" },
] as const;
const mounted: ReturnType<typeof mount>[] = [];

function render(field: ChatBindingField) {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BindingScopeNote, { target, props: { field } }));
    flushSync();
    return target;
}

beforeEach(() => {
    changeLanguage("en");
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chats: [
                    {
                        id: "chat",
                        name: "Chat",
                        message: [],
                        localLore: [],
                        promptPresetId: "p2",
                        modelPresetId: "m2",
                        bindedPersona: "u2",
                    },
                ],
            },
        ],
        botPresets: [
            { id: "p1", name: "Tab prompt" },
            { id: "p2", name: "Bound prompt" },
        ],
        modelPresets: [
            { id: "m1", name: "Tab model" },
            { id: "m2", name: "Bound model" },
        ],
        personas: [
            { id: "u1", name: "Tab persona" },
            { id: "u2", name: "Bound persona" },
        ],
    });
    selectPreset("p1");
    selectModelPreset("m1");
    selectPersona("u1");
    selectCharacter("c");
    selectChat("c", "chat");
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    document.body.replaceChildren();
    selectCharacter(null);
});

describe("BindingScopeNote", () => {
    it.each(fields)(
        "$field distinguishes another, matching and missing binding; Show selects without binding",
        ({ field, selectionKey, boundId }) => {
            const note = render(field);
            const bindingBefore = chatBindingIds(ref);
            expect(bindingBefore).toMatchObject(binding);
            expect(note.querySelector("span")?.textContent?.trim()).toBe("Not this chat's");
            const show = note.querySelector<HTMLButtonElement>(`[data-binding-scope-show="${field}"]`)!;
            expect(show?.textContent?.trim()).toBe("Show this chat's");
            const tabBefore = {
                presetId: selection.presetId,
                modelPresetId: selection.modelPresetId,
                personaId: selection.personaId,
            };
            show.click();
            flushSync();
            expect({
                presetId: selection.presetId,
                modelPresetId: selection.modelPresetId,
                personaId: selection.personaId,
            }).toEqual({ ...tabBefore, [selectionKey]: boundId });
            expect(chatBindingIds(ref)).toEqual(bindingBefore);
            expect(note.textContent?.trim()).toBe("This chat");
            expect(note.querySelector("button")).toBeNull();

            for (const id of [null, "deleted-record"]) {
                chatBindingPatch(ref, { [field]: id });
                flushSync();
                expect(note.textContent?.trim()).toBe("Not set for this chat");
                expect(note.querySelector("button")).toBeNull();
            }
        },
    );

    it("renders nothing for any field at home", () => {
        selectCharacter(null);
        for (const { field } of fields) {
            const note = render(field);
            expect(note.textContent?.trim()).toBe("");
            expect(note.querySelector("button")).toBeNull();
        }
    });
});
