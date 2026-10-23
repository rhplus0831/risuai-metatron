import { selectCharacter } from "./storage/selection.svelte";
import { characterList, selectedCharacter } from "./storage/characterStore.svelte";
import { settings } from "./storage/settingsViews.svelte";
import { get } from "svelte/store";
import {
    alertMd,
    alertNormal,
    alertSelect,
    alertToast,
    alertWait,
    doingAlert,
    alertRequestLogs,
    terminalNotice,
} from "./alert";
import { pickBinding } from "./storage/chatBindingPick";
import {
    alertStore,
    chatBindingDialog,
    gridOpenStore,
    openModelPresetList,
    openPersonaList,
    openPresetList,
    OpenRealmStore,
    PlaygroundStore,
    popUpEditorStore,
    SafeModeStore,
    settingsOpen,
} from "./stores.svelte";
import { language } from "src/lang";
import { updateTextThemeAndCSS } from "./gui/colorscheme";
import { defaultHotkeys } from "./defaulthotkeys";
import { previewChat } from "./process/index.svelte";
import { isChatBusy } from "./process/chatStatus.svelte";
import { currentChatRef } from "./storage/chatStore.svelte";
import { RISU_SIDEBAR_DRAG_TYPE } from "./dragTypes";
import { createDialogKeyGate } from "./alertQueue";
import { chatCheckpointsDialog, checkpointLoadBusy } from "./checkpoints/chatCheckpoints.svelte";

export function initHotkey() {
    // Every stroke of Enter and Escape, seen before any element can stop it: a dialog takes a key only
    // from a stroke that began after it appeared (`createDialogKeyGate`).
    const dialogKeys = createDialogKeyGate(alertStore);
    window.addEventListener("keydown", (ev) => dialogKeys.keydown(ev), true);
    window.addEventListener("keyup", (ev) => dialogKeys.keyup(ev), true);
    window.addEventListener("blur", () => dialogKeys.reset());
    document.addEventListener("keydown", async (ev) => {
        // The terminal notice is a modal dialog with its own keys: no shortcut runs behind it.
        if (get(terminalNotice) !== null) {
            return;
        }
        const hasDialogs = alertStore.hasDialogs();
        if (ev.key === "Escape" && hasDialogs) {
            // Panels underneath also listen on window; even a rejected Escape stays with the dialog.
            ev.preventDefault();
            ev.stopPropagation();
        }
        // A checkpoint load holds the modal through its flush and refresh. Alerts above it still
        // handle Enter/Escape below, but no shortcut may send or switch screens behind it.
        const loadingCheckpoint = get(checkpointLoadBusy);
        if (loadingCheckpoint && !hasDialogs) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }
        // Escape closes the topmost picker list or binding dialog also from a text field (a preset's
        // rename, or the composer that kept the focus); an alert above it closes first (below).
        const bindingLayer = ev.key === "Escape" && !doingAlert() ? topBindingLayer() : null;
        if (bindingLayer) {
            closeBindingLayer(bindingLayer);
            ev.preventDefault();
            return;
        }
        const alertInput =
            alertStore.dialogVisible() &&
            get(alertStore).type === "input" &&
            ev.target instanceof HTMLInputElement &&
            ev.target.id === "alert-input" &&
            ev.target.closest("[data-alert-dialog]")
                ? ev.target
                : null;
        const plainKey = !ev.ctrlKey && !ev.altKey && !ev.shiftKey;
        if (
            plainKey &&
            isTextEntry(document.activeElement) &&
            !(alertInput && (ev.key === "Enter" || ev.key === "Escape"))
        ) {
            return;
        }

        const hotKeys =
            loadingCheckpoint || (hasDialogs && plainKey)
                ? []
                : enabledHotkeys(settings.hotkeys ?? defaultHotkeys, settings.ui);

        let hotkeyRan = false;
        for (const hotkey of hotKeys) {
            let hotKeyRanThisTime = true;

            if (!hotkeyMatches(hotkey, ev)) {
                continue;
            }
            switch (hotkey.action) {
                case "reroll": {
                    clickQuery(".button-icon-reroll");
                    break;
                }
                case "unreroll": {
                    clickQuery(".button-icon-unreroll");
                    break;
                }
                case "translate": {
                    clickQuery(".button-icon-translate");
                    break;
                }
                case "remove": {
                    clickQuery(".button-icon-remove");
                    break;
                }
                case "edit": {
                    clickQuery(".button-icon-edit");
                    setTimeout(() => {
                        focusQuery(".message-edit-area");
                    }, 100);
                    break;
                }
                case "copy": {
                    clickQuery(".button-icon-copy");
                    break;
                }
                case "focusInput": {
                    focusQuery(".text-input-area");
                    break;
                }
                case "send": {
                    clickQuery(".button-icon-send");
                    break;
                }
                case "settings": {
                    settingsOpen.set(!get(settingsOpen));
                    break;
                }
                case "home": {
                    selectCharacter(null);
                    break;
                }
                case "presets": {
                    openPresetList.set(!get(openPresetList));
                    break;
                }
                case "persona": {
                    openPersonaList.set(!get(openPersonaList));
                    break;
                }
                case "modelSelect": {
                    openModelPresetList.set(!get(openModelPresetList));
                    break;
                }
                case "toggleCSS": {
                    SafeModeStore.set(!get(SafeModeStore));
                    updateTextThemeAndCSS();
                    break;
                }
                case "prevChar": {
                    // By name; from the first character (or home) there is no previous one.
                    const sorted = sortedByName();
                    const selectedId = selectedCharacter()?.chaId;
                    const currentIndex = sorted.findIndex((v) => v.chaId === selectedId);
                    if (currentIndex <= 0) {
                        return;
                    }
                    selectCharacter(sorted[currentIndex - 1].chaId);
                    PlaygroundStore.set(0);
                    OpenRealmStore.set(false);
                    break;
                }
                case "nextChar": {
                    // By name; from home it is the first character, from the last there is none.
                    const sorted = sortedByName();
                    const selectedId = selectedCharacter()?.chaId;
                    const currentIndex = sorted.findIndex((v) => v.chaId === selectedId);
                    if (currentIndex >= sorted.length - 1) {
                        return;
                    }
                    selectCharacter(sorted[currentIndex + 1].chaId);
                    PlaygroundStore.set(0);
                    OpenRealmStore.set(false);
                    break;
                }
                case "quickMenu": {
                    quickMenu();
                    break;
                }
                case "previewRequest": {
                    // The selected chat's request body; refused while that chat has work of its own.
                    const ref = currentChatRef();
                    if (ref && isChatBusy(ref)) {
                        return false;
                    }
                    alertWait("Loading...");
                    const wait = alertStore.status();
                    ev.preventDefault();
                    ev.stopPropagation();
                    try {
                        const body = await previewChat("previewPrompt", ref ?? undefined);
                        if (body === null) {
                            // Refused or failed: nothing to show.
                            return;
                        }
                        let md = "";
                        md += "### Prompt\n";
                        md +=
                            "```json\n" +
                            JSON.stringify(JSON.parse(body), null, 2).replaceAll("```", "\\`\\`\\`") +
                            "\n```\n";
                        alertMd(md);
                    } finally {
                        // A result or an alert has replaced the wait; a silent refusal leaves it to clear.
                        if (wait) {
                            alertStore.clearStatus(wait);
                        }
                    }
                    return;
                }
                case "toggleLog": {
                    alertRequestLogs();
                    break;
                }
                case "quickSettings": {
                    // The quick settings panel is gone; the key stays caught and says where its parts went.
                    alertNormal(language.quickSettingsRemoved);
                    break;
                }
                case "scrollToActiveChar": {
                    if (settings.ui.enableScrollToActiveChar !== false) {
                        window.dispatchEvent(new CustomEvent("scrollToActiveCharacter"));
                    }
                    break;
                }
                default: {
                    hotKeyRanThisTime = false;
                }
            }

            if (hotKeyRanThisTime) {
                hotkeyRan = true;
                break;
            }
        }

        if (hotkeyRan) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }

        if (ev.ctrlKey && !loadingCheckpoint) {
            switch (ev.key) {
                case "1": {
                    changeToPreset(0);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "2": {
                    changeToPreset(1);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "3": {
                    changeToPreset(2);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "4": {
                    changeToPreset(3);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "5": {
                    changeToPreset(4);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "6": {
                    changeToPreset(5);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "7": {
                    changeToPreset(6);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "8": {
                    changeToPreset(7);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
                case "9": {
                    changeToPreset(8);
                    ev.preventDefault();
                    ev.stopPropagation();
                    break;
                }
            }
        }
        if (ev.key === "Escape") {
            // Read before closing: a dialog (also one waiting for the gap) or a progress overlay.
            const hadAlert = doingAlert();
            if (alertStore.dialogVisible()) {
                // The shown dialog closes with "" (its caller's dismissal); the toast says so once
                // no other dialog waits.
                if (dialogKeys.accepts(ev)) {
                    alertStore.answer("");
                    if (!alertStore.hasDialogs()) {
                        alertToast("Alert Closed");
                    }
                }
            } else if (!alertStore.hasDialogs() && get(alertStore).type === "progress") {
                // A progress overlay is a status: the toast replaces it until its next update.
                alertToast("Alert Closed");
            }
            // Only the topmost layer closes: the settings and the grid stay under a picker list or the
            // binding dialog (one without an alert above it closed at the top of this handler).
            if (!alertStore.hasDialogs() && topBindingLayer() === null) {
                if (get(settingsOpen)) {
                    settingsOpen.set(false);
                } else if (get(gridOpenStore) && !hadAlert) {
                    // The character grid closes like settings (its URL is a layer, `router/router.svelte.ts`).
                    gridOpenStore.set(false);
                }
            }
            ev.preventDefault();
        }
        if (ev.key === "Enter" && alertStore.dialogVisible()) {
            const alertType = get(alertStore).type;
            if (ev.target instanceof Element && ev.target.closest("[data-alert-dialog] button")) {
                // A new stroke activates the chosen button; a rejected one cannot click it natively.
                if (!dialogKeys.accepts(ev)) {
                    ev.preventDefault();
                }
            } else if (alertInput || alertType === "ask" || alertType === "normal" || alertType === "error") {
                if (dialogKeys.accepts(ev)) {
                    alertStore.answer(alertInput ? alertInput.value : "yes");
                }
                ev.preventDefault();
            }
        }
    });

    let touchs = 0;
    let touchStartTime = 0;
    //check for triple touch
    document.addEventListener("touchstart", (ev) => {
        touchs++;
        if (touchs > 2) {
            if (Date.now() - touchStartTime > 300) {
                return;
            }
            touchs = 0;
            if (doingAlert()) {
                return;
            }
            quickMenu();
        }
        if (touchs === 1) {
            touchStartTime = Date.now();
        }
    });
    document.addEventListener("touchend", (ev) => {
        touchs = 0;
    });

    let lastScrollTime = 0;
    const SCROLL_COOLDOWN = 500;

    document.addEventListener(
        "dragover",
        (ev) => {
            if (ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
                const types = ev.dataTransfer?.types || [];
                const isCharacterDrag = types.includes(RISU_SIDEBAR_DRAG_TYPE);

                if (isCharacterDrag) {
                    if (settings.ui.enableScrollToActiveChar !== false) {
                        const now = Date.now();
                        if (now - lastScrollTime > SCROLL_COOLDOWN) {
                            lastScrollTime = now;
                            window.dispatchEvent(new CustomEvent("scrollToActiveCharacter"));
                        }
                    }
                }
            }
        },
        true,
    );
}

async function quickMenu() {
    const selStr = await alertSelect([language.presets, language.persona, language.cancel]);
    const sel = parseInt(selStr);
    if (sel === 0) {
        openPresetList.set(!get(openPresetList));
    }
    if (sel === 1) {
        openPersonaList.set(!get(openPersonaList));
    }
}

/** The characters (a copy of the list's rows) sorted by name, for the previous/next hotkeys. */
function sortedByName(): { name: string; chaId: string }[] {
    return characterList()
        .map((v) => ({ name: v.name, chaId: v.chaId }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The hotkeys the key handler matches: `scrollToActiveChar` only while its feature is on. The stored
 * list always holds it (the server merges the built-in hotkeys back in), so the filter lives with the
 * readers.
 */
function enabledHotkeys<T extends { action: string }>(
    hotkeys: T[],
    db: { enableScrollToActiveChar?: boolean } | undefined,
): T[] {
    return db?.enableScrollToActiveChar === false
        ? hotkeys.filter((hotkey) => hotkey.action !== "scrollToActiveChar")
        : hotkeys;
}

/**
 * The hotkeys the hotkey table lists: the enabled ones without `quickSettings`, which the handler
 * still matches (to show the removal notice) but which has nothing left to configure.
 */
export function activeHotkeys<T extends { action: string }>(
    hotkeys: T[],
    db: { enableScrollToActiveChar?: boolean } | undefined,
): T[] {
    return enabledHotkeys(hotkeys, db).filter((hotkey) => hotkey.action !== "quickSettings");
}

export function hotkeyMatches(hotkey: (typeof settings.hotkeys)[number], ev: KeyboardEvent): boolean {
    if (!hotkey) {
        return false;
    }

    // A missing modifier flag means "not held". The hotkey is the stored record's element, so this
    // only reads it: a write would save the hotkey list.
    const ctrl = hotkey.ctrl ?? false;
    const alt = hotkey.alt ?? false;
    const shift = hotkey.shift ?? false;

    if (ctrl !== ev.ctrlKey) return false;
    if (alt !== ev.altKey) return false;
    if (shift !== ev.shiftKey) return false;
    if (hotkey.key.toLowerCase() !== ev.key.toLowerCase()) return false;
    if (!ctrl && !alt && !shift) {
        if (isTextEntry(document.activeElement)) return false;
    }
    return true;
}

/**
 * Whether keys typed into `element` are text, so a plain-key hotkey must not take them: an input, a
 * textarea, editable content, or an EditContext host (Chrome's input element that is neither, as
 * Monaco's would be without `editContext: false`).
 */
function isTextEntry(element: Element | null): boolean {
    if (!element) {
        return false;
    }
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        return true;
    }
    const editable = element.getAttribute("contenteditable");
    if ((element as HTMLElement).isContentEditable || (editable !== null && editable !== "false")) {
        return true;
    }
    return ((element as { editContext?: unknown }).editContext ?? null) !== null;
}

function clickQuery(query: string) {
    let ele = document.querySelector(query) as HTMLElement;
    console.log(ele);
    if (ele) {
        ele.click();
    }
}

function focusQuery(query: string) {
    let ele = document.querySelector(query) as HTMLElement;
    if (ele) {
        ele.focus();
    }
}

type BindingLayer = "personaList" | "modelPresetList" | "presetList" | "checkpointsDialog" | "bindingDialog";

/** The topmost open chat dialog or picker list, following their mount order in `App.svelte`. */
function topBindingLayer(): BindingLayer | null {
    if (get(openPersonaList)) {
        return "personaList";
    }
    if (get(openModelPresetList)) {
        return "modelPresetList";
    }
    if (get(openPresetList)) {
        return "presetList";
    }
    if (get(chatCheckpointsDialog)) {
        return "checkpointsDialog";
    }
    if (get(chatBindingDialog)) {
        return "bindingDialog";
    }
    return null;
}

function closeBindingLayer(layer: BindingLayer) {
    switch (layer) {
        case "personaList":
            openPersonaList.set(false);
            break;
        case "modelPresetList":
            openModelPresetList.set(false);
            break;
        case "presetList":
            openPresetList.set(false);
            break;
        case "bindingDialog":
            chatBindingDialog.set(null);
            break;
        case "checkpointsDialog":
            if (!get(checkpointLoadBusy)) chatCheckpointsDialog.set(null);
            break;
    }
}

/**
 * Ctrl+1..9: picks the prompt preset for the open chat's binding, else (home) the tab's selection.
 * The number counts the active (not archived) presets in list order, as the list's active view numbers them.
 */
function changeToPreset(num: number) {
    // The popup editor writes its draft back to the field it was opened on when it closes; with a
    // forwarded preset field that is the shown preset, so it must not change meanwhile. Nothing runs
    // behind a picker list or the binding dialog, which may be choosing for another chat.
    if (!doingAlert() && !popUpEditorStore.open && topBindingLayer() === null) {
        const pres = settings.presets.filter((preset) => preset.archived !== true);
        if (pres.length > num) {
            if (pickBinding("promptPresetId", pres[num].id)) {
                alertToast(`Changed to Preset: ${pres[num].name}`);
            }
        }
    }
}
