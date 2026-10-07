import { untrack } from "svelte";
import { writable, type Writable } from "svelte/store";
import { characterData, characterIndex, setCharacterMembershipHook } from "./records.svelte";

/**
 * The per-client selection (Phase 3, `PLAN.md` Decision 3): which preset and persona this browser
 * uses, which global lorebook page it shows, and (Phase 6 slice 5) which character this tab shows. It is not shared data and is never saved to the server. Each
 * change is kept in `sessionStorage`, so a reload restores this tab's selection even when another
 * tab of the same browser chose differently, and in `localStorage`, the starting selection of a new
 * tab (the last choice made in any tab). The forwarding layer
 * (`forwarding.svelte.ts`) resolves every read against the current collections, so an id that names
 * no record (deleted here, by another client, or by a plugin) falls back to the first record there.
 */
export interface Selection {
    /** The selected preset's id, or `""` before the first resolution. */
    presetId: string;
    /** The selected persona's id, or `""` before the first resolution. */
    personaId: string;
    /** The index of the shown global lorebook page. */
    loreBookPage: number;
    /**
     * The selected character's `chaId`, `null` for home. Per tab and never stored: a reload starts at
     * home. It always names a character in the list (a removed one makes it `null`).
     */
    characterId: string | null;
}

const STORAGE_KEY = "risu-selection";

export const selection: Selection = $state({ presetId: "", personaId: "", loreBookPage: 0, characterId: null });

function save() {
    const text = JSON.stringify({
        presetId: selection.presetId,
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
// The selected character (Phase 6 slice 5). `selectedCharacterIndex` is the index store the app
// knows as `selectedCharID` (`stores.svelte.ts`): its value is the index of `selection.characterId`
// in the character list (-1: home), and `set(index)` selects the character at that index. A read is
// synchronous (`get` right after `set` answers the new index), and subscribers hear of every change
// at once: a selection, and every completed membership change of the list (the records' hook), so a
// subscriber never indexes the list with an index from before the change.

/**
 * The published index: a Svelte `writable` (its subscriber queue and invalidation protocol keep
 * derived stores consistent), set synchronously to the current index after every change.
 */
const published = writable(-1);
const selectedListeners = new Set<(chaId: string) => void>();
const changeListeners = new Set<() => void>();

function currentIndex(): number {
    return untrack(() => characterIndex(selection.characterId));
}

function publish() {
    published.set(currentIndex());
}

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
        // The index is published first, so a listener (and every subscriber) reads the new selection.
        publish();
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

/** The selection as an index store (`selectedCharID`): subscribe, set, update. */
export const selectedCharacterIndex: Writable<number> = {
    subscribe: published.subscribe,
    set(index: number) {
        selectCharacterAt(index);
    },
    update(fn: (index: number) => number) {
        selectCharacterAt(fn(currentIndex()));
    },
};

// After every completed membership change: a selected character that left the list selects home.
setCharacterMembershipHook(() => {
    if (selection.characterId !== null && untrack(() => characterIndex(selection.characterId)) === -1) {
        selection.characterId = null;
    }
    publish();
});
