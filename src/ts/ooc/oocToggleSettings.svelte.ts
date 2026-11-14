/** OOC toggle settings use the chat's display preset and remember suggestion decisions on this device. */
import { oocToggleValues } from "../../../shared/ooc.ts";
import { parseToggleSyntax, toggleKindOf, valueToggles } from "../../../shared/prompt/toggles.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { chatDisplayIds } from "../storage/chatBinding.svelte";
import { findChat, setChatMeta, type ChatRef } from "../storage/chatStore.svelte";
import { readPresetFieldOf, writePresetField } from "../storage/settingsViews.svelte";

/** A detached map of bare toggle keys; malformed imported values never reach the editor or writes. */
export function oocToggleMap(value: unknown): Record<string, string> {
    return Object.fromEntries(
        isPlainObject(value)
            ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
            : [],
    );
}

export function presetOocToggles(ref: ChatRef) {
    const { presetId, modelPresetId } = chatDisplayIds(ref);
    const scope = { presetId, modelPresetId };
    return { scope, map: oocToggleMap(readPresetFieldOf(scope, "oocToggles")) };
}

/** An own map replaces the preset whole, including when the copied map is empty. */
export function useOwnOocToggles(ref: ChatRef, enabled: boolean): void {
    if (!findChat(ref)) return;
    if (enabled) {
        const { map } = presetOocToggles(ref);
        setChatMeta(ref, { oocToggles: map });
    } else {
        setChatMeta(ref, {}, ["oocToggles"]);
    }
}

/** Returns only the first checkbox match, and only when the effective map forces no values. */
export function oocToggleSuggestion(definitionsText: string, chatMap: unknown, presetMap: unknown) {
    if (Object.keys(oocToggleValues(chatMap, presetMap)).length) return undefined;
    const toggle = valueToggles(parseToggleSyntax(definitionsText)).find(
        (toggle) => toggleKindOf(toggle) === "checkbox" && /ooc/i.test(`${toggle.key}\n${toggle.value}`),
    );
    return toggle ? { key: toggle.key, label: toggle.value } : undefined;
}

const STORAGE_KEY = "risu-ooc-toggle-offered-presets";
let unsaved: string[] | null = null;
let decisionRevision = $state(0);

function offeredPresetIds(): string[] {
    if (unsaved !== null) return unsaved;
    try {
        const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
        return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

export function oocToggleOfferHandled(presetId: string): boolean {
    // Storage itself is not reactive; a decision also invalidates mounted panels in this tab.
    void decisionRevision;
    return offeredPresetIds().includes(presetId);
}

function rememberOffer(presetId: string): void {
    const ids = [...new Set([...offeredPresetIds(), presetId])];
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
        unsaved = null;
    } catch {
        unsaved = ids;
    }
    decisionRevision++;
}

/** Re-check the captured chat and offer at click time; a late event never changes a different preset. */
export function answerOocToggleOffer(ref: ChatRef, presetId: string, key: string, force: boolean): void {
    const chat = findChat(ref);
    if (!chat) return;
    const { scope, map } = presetOocToggles(ref);
    if (scope.presetId !== presetId || oocToggleOfferHandled(presetId)) return;
    if (force) writePresetField(scope, "oocToggles", { ...map, [key]: "1" });
    rememberOffer(presetId);
}
