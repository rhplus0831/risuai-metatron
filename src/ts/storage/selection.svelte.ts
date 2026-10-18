import { untrack } from "svelte";
import { writable } from "svelte/store";
import { characterData, characterIndex, setCharacterMembershipHook } from "./records.svelte";

/**
 * The per-client selection (Phase 3, `PLAN.md` Decision 3): which prompt preset, model preset
 * (`docs/plan/split-preset.md`), and persona this browser uses, which global lorebook page it shows, and (Phase 6 slice 5) which character this tab shows. It is not shared data and is never saved to the server. Each
 * change is kept in `sessionStorage`, so a reload restores this tab's selection even when another
 * tab of the same browser chose differently, and in `localStorage`, the starting selection of a new
 * tab (the last choice made in any tab). The settings views
 * (`settingsViews.svelte.ts`) resolve every read against the current collections, so an id that names
 * no record (deleted here, by another client, or by a plugin) falls back to the first record there.
 */
export interface Selection {
    /** The selected prompt preset's id, or `""` before the first resolution. */
    presetId: string;
    /** The selected model preset's id, or `""` before the first resolution. */
    modelPresetId: string;
    /** The selected persona's id, or `""` before the first resolution. */
    personaId: string;
    /** The index of the shown global lorebook page. */
    loreBookPage: number;
    /**
     * The selected character's `chaId`, `null` for home. Per tab and never stored here: the URL holds it,
     * so a reload restores it (the router, `router/router.svelte.ts`). It always names a character in
     * the list (a removed one makes it `null`).
     */
    characterId: string | null;
    /**
     * Whether the selected character's selected chat is open on the chat screen (per tab, never
     * stored; the URL holds it). Selecting another character closes it, so a character opens on its
     * closed-chat screen and a chat opens only when the user picks one (`changeChatTo`). Always false
     * at home. The playground chat ignores it.
     */
    chatOpen: boolean;
}

const STORAGE_KEY = "risu-selection";

export const selection: Selection = $state({
    presetId: "",
    modelPresetId: "",
    personaId: "",
    loreBookPage: 0,
    characterId: null,
    chatOpen: false,
});

/** This tab's base screen: 0 for character chats, 2 for the playground chat. Never persisted. */
export const PlaygroundStore = writable(0);

function save() {
    const text = JSON.stringify({
        presetId: selection.presetId,
        modelPresetId: selection.modelPresetId,
        personaId: selection.personaId,
        loreBookPage: selection.loreBookPage,
    });
    for (const storage of [() => sessionStorage, () => localStorage]) {
        try {
            storage().setItem(STORAGE_KEY, text);
        } catch {
            // Storage can be unavailable (private mode, quota); the selection then lasts until reload.
        }
    }
}

function read(storage: () => Storage): Partial<Record<keyof Selection, unknown>> | null {
    try {
        const parsed: unknown = JSON.parse(storage().getItem(STORAGE_KEY) ?? "null");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Reads this tab's stored selection, else the browser's last one. Runs before the database is installed; ids are checked lazily. */
export function loadSelection() {
    const stored = read(() => sessionStorage) ?? read(() => localStorage);
    selection.presetId = typeof stored?.presetId === "string" ? stored.presetId : "";
    selection.modelPresetId = typeof stored?.modelPresetId === "string" ? stored.modelPresetId : "";
    selection.personaId = typeof stored?.personaId === "string" ? stored.personaId : "";
    const page = stored?.loreBookPage;
    selection.loreBookPage = Number.isInteger(page) && (page as number) >= 0 ? (page as number) : 0;
}

export function selectPreset(id: string) {
    if (selection.presetId !== id) {
        selection.presetId = id;
        save();
    }
}

export function selectModelPreset(id: string) {
    if (selection.modelPresetId !== id) {
        selection.modelPresetId = id;
        save();
    }
}

export function selectPersona(id: string) {
    if (selection.personaId !== id) {
        selection.personaId = id;
        save();
    }
}

export function selectLoreBookPage(page: number) {
    if (selection.loreBookPage !== page) {
        selection.loreBookPage = page;
        save();
    }
}

// ---------------------------------------------------------------------------------------------
// The selected character (Phase 6 slice 5), by id: `selection.characterId` (`null`: home).
// `selectedIndex()` is its index in the character list, tracked; a completed membership change of
// the list that removes the selected character selects home (the records' hook below).

const selectedListeners = new Set<(chaId: string) => void>();
const changeListeners = new Set<() => void>();

/** Registers a listener called when a tab selects a character (not home, not a reconciliation). */
export function onCharacterSelected(listener: (chaId: string) => void): () => void {
    selectedListeners.add(listener);
    return () => {
        selectedListeners.delete(listener);
    };
}

/** Registers a listener called after every change of the selected character by `selectCharacter`, home included. */
export function onCharacterSelectionChanged(listener: () => void): () => void {
    changeListeners.add(listener);
    return () => {
        changeListeners.delete(listener);
    };
}

/** Selects the character with `chaId` (`null`, or an id no character has: home). */
export function selectCharacter(chaId: string | null) {
    untrack(() => {
        const id = chaId !== null && characterIndex(chaId) !== -1 ? chaId : null;
        const changed = selection.characterId !== id;
        selection.characterId = id;
        if (changed) {
            selection.chatOpen = false;
        }
        if (changed) {
            for (const listener of [...changeListeners]) {
                listener();
            }
        }
        if (!changed || id === null) {
            return;
        }
        for (const listener of [...selectedListeners]) {
            // A subscriber or an earlier listener selected again: this selection is no longer news.
            if (selection.characterId !== id) {
                return;
            }
            listener(id);
        }
    });
}

/** Opens or closes the selected character's selected chat (`selection.chatOpen`); nothing is open at home. */
export function setChatOpen(open: boolean) {
    selection.chatOpen = open && untrack(() => selection.characterId) !== null;
}

/** Selects the character at `index` of the list (-1 or no character there: home). */
export function selectCharacterAt(index: number) {
    const list = characterData();
    const chaId = Number.isInteger(index) && index >= 0 && index < list.length ? list[index]?.chaId : undefined;
    selectCharacter(typeof chaId === "string" ? chaId : null);
}

/** The selected character's index, tracked (for a `$derived` or a template); -1 at home. */
export function selectedIndex(): number {
    return selectedIndexState.value;
}

class SelectedIndexState {
    value = $derived(characterIndex(selection.characterId));
}
const selectedIndexState = new SelectedIndexState();

// After every completed membership change: a selected character that left the list selects home.
setCharacterMembershipHook(() => {
    if (selection.characterId !== null && untrack(() => characterIndex(selection.characterId)) === -1) {
        selection.characterId = null;
        selection.chatOpen = false;
    }
});
