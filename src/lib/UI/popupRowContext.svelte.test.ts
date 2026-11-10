// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => ({ input: vi.fn(), change: vi.fn() }));
vi.mock("src/lib/UI/GUI/TextAreaInput.svelte", async (original) => {
    const real = await original<typeof import("src/lib/UI/GUI/TextAreaInput.svelte")>();
    const { observeTextAreaCallbacks } = await import("./tests/observeTextAreaCallbacks");
    return { ...real, default: observeTextAreaCallbacks(real.default, callbacks) };
});
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
// The stores' module effect is unrelated to popup edits; keep the rest of this module real.
vi.mock("src/ts/process/modules", async (original) => ({
    ...(await original<typeof import("src/ts/process/modules")>()),
    moduleUpdate: vi.fn(),
}));

import PromptDataItem from "./PromptDataItem.svelte";
import RegexData from "../SideBars/Scripts/RegexData.svelte";
import { language } from "src/lang";
import type { character, customscript } from "src/ts/storage/database.svelte";
import { defaultHotkeys } from "src/ts/defaulthotkeys";
import { activePreset } from "src/ts/storage/settingsViews.svelte";
import {
    applyRaw,
    patchRawCharacter,
    recordData,
    recordValueIdentity,
    resetRecords,
    setCharacterWriteListener,
    setRecordWriteListener,
    trackedCharacters,
} from "src/ts/storage/records.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { closePopupEditorSession, popUpEditorStore, ReloadGUIPointer } from "src/ts/stores.svelte";

// Both hosts follow the real parents' index bindings. A retained record wrapper can follow a new
// backing row at index zero, even if the replacement has exactly the same edited text.
type Kind = "prompt" | "regex";
const initialPopup = { ...popUpEditorStore };
const mounted: ReturnType<typeof mount>[] = [];
const scripts = (): customscript[] => [
    { comment: "A", in: "a", out: "same text", type: "editinput", flag: "" },
    { comment: "B", in: "b", out: "same text", type: "editinput", flag: "" },
];
const character = () => trackedCharacters<character[]>()![0];
const rows = (kind: Kind) => (kind === "prompt" ? activePreset.promptTemplate! : character().customscript);
const texts = (kind: Kind) =>
    kind === "prompt"
        ? activePreset.promptTemplate!.map((row) => (row.type === "plain" ? row.text : undefined))
        : character().customscript.map((row) => row.out);
const names = (kind: Kind) =>
    kind === "prompt"
        ? activePreset.promptTemplate!.map((row) => row.name)
        : character().customscript.map((row) => row.comment);

function openRow(kind: Kind) {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
        kind === "prompt"
            ? mount(PromptDataItem, {
                  target,
                  props: {
                      get promptItem() {
                          return activePreset.promptTemplate![0];
                      },
                      set promptItem(value) {
                          activePreset.promptTemplate![0] = value;
                      },
                      isOpened: true,
                      popupEditorContext: activePreset.id,
                  },
              })
            : mount(RegexData, {
                  target,
                  props: {
                      get value() {
                          return character().customscript[0];
                      },
                      set value(value) {
                          character().customscript[0] = value;
                      },
                      idx: 0,
                      popupEditorContext: "char",
                  },
              }),
    );
    flushSync();
    if (kind === "regex") {
        target.querySelector<HTMLButtonElement>("button.valuer")!.click();
        flushSync();
    }
    const expand = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`);
    expect(expand).not.toBeNull();
    expand!.click();
    flushSync();
    expect(popUpEditorStore).toMatchObject({ open: true, value: "same text" });
}

async function closePopup() {
    closePopupEditorSession(popUpEditorStore.sessionId);
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    callbacks.input.mockClear();
    callbacks.change.mockClear();
    installFlatDatabase({
        promptTemplate: [
            { type: "plain", name: "A", text: "same text", role: "system" },
            { type: "plain", name: "B", text: "same text", role: "system" },
        ],
        characters: [{ chaId: "char", type: "character", customscript: scripts() }],
        hotkeys: structuredClone(defaultHotkeys),
    });
});

afterEach(async () => {
    setRecordWriteListener(null);
    setCharacterWriteListener(null);
    for (const instance of mounted.splice(0)) await unmount(instance);
    Object.assign(popUpEditorStore, initialPopup);
    document.body.replaceChildren();
    resetRecords();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe.each(["prompt", "regex"] as const)("%s row popup", (kind) => {
    it("discards a draft after a remote swap of rows with equal text", async () => {
        const wrapper = rows(kind)[0];
        openRow(kind);
        popUpEditorStore.value = "draft for A";
        if (kind === "prompt") {
            const fresh = JSON.parse(JSON.stringify(recordData("presets")));
            fresh[0].promptTemplate.reverse();
            applyRaw("presets", fresh);
        } else {
            expect(patchRawCharacter("char", [["customscript", scripts().reverse()]])).toBe(true);
        }
        flushSync();
        expect(rows(kind)[0]).toBe(wrapper);
        await closePopup();
        expect(names(kind)).toEqual(["B", "A"]);
        expect(texts(kind)).toEqual(["same text", "same text"]);
        expect(callbacks.input).not.toHaveBeenCalled();
        expect(callbacks.change).not.toHaveBeenCalled();
    });

    it("writes the draft to an unchanged row and calls both consumers once", async () => {
        openRow(kind);
        const reload = get(ReloadGUIPointer);
        popUpEditorStore.value = "draft for A";
        await closePopup();
        expect(texts(kind)).toEqual(["draft for A", "same text"]);
        expect(callbacks.input).toHaveBeenCalledTimes(1);
        expect(callbacks.change).toHaveBeenCalledTimes(1);
        if (kind === "regex") expect(get(ReloadGUIPointer)).toBe(reload + 1);
    });

    it("keeps the draft and callbacks when write-back rebuilds the array with the same rows", async () => {
        openRow(kind);
        const token = recordValueIdentity(rows(kind)[0]);
        const reload = get(ReloadGUIPointer);
        let rebuilt = false;
        // A synchronous parent update before TextAreaInput resumes after tick(). The row's backing
        // object survives, so the row context must retain its identity through the recomputation.
        const rebuild = () => {
            if (rebuilt) return;
            rebuilt = true;
            if (kind === "prompt") activePreset.promptTemplate = Array.from(activePreset.promptTemplate!);
            else character().customscript = Array.from(character().customscript);
        };
        if (kind === "prompt")
            setRecordWriteListener((written) => {
                if (written === "presets") rebuild();
            });
        else setCharacterWriteListener({ character: rebuild, membership: () => {} });
        popUpEditorStore.value = "draft for A";
        await closePopup();
        expect(rebuilt).toBe(true);
        expect(recordValueIdentity(rows(kind)[0])).toBe(token);
        expect(texts(kind)).toEqual(["draft for A", "same text"]);
        expect(callbacks.input).toHaveBeenCalledTimes(1);
        expect(callbacks.change).toHaveBeenCalledTimes(1);
        if (kind === "regex") expect(get(ReloadGUIPointer)).toBe(reload + 1);
    });
});
