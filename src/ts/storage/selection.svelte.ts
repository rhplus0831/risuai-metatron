/**
 * The per-client selection (Phase 3, `PLAN.md` Decision 3): which preset and persona this browser
 * uses and which global lorebook page it shows. It is not shared data and is never saved to the server. Each
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
}

const STORAGE_KEY = "risu-selection";

export const selection: Selection = $state({ presetId: "", personaId: "", loreBookPage: 0 });

function save() {
    const text = JSON.stringify(selection);
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
