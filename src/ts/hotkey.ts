import { selectCharacter } from "./storage/selection.svelte";
import { characterList, selectedCharacter } from "./storage/characterStore.svelte";
import { settings } from "./storage/settingsViews.svelte";
import { get } from "svelte/store";
import { alertMd, alertSelect, alertToast, alertWait, doingAlert, alertRequestLogs, terminalNotice } from "./alert";
import { changeToPreset as changeToPreset2 } from "./storage/database.svelte";
import {
    alertStore,
    openPersonaList,
    openPresetList,
    OpenRealmStore,
    PlaygroundStore,
    popUpEditorStore,
    QuickSettings,
    SafeModeStore,
    settingsOpen,
} from "./stores.svelte";
import { language } from "src/lang";
import { updateTextThemeAndCSS } from "./gui/colorscheme";
import { defaultHotkeys } from "./defaulthotkeys";
import { doingChat, previewBody, sendChat } from "./process/index.svelte";
import { RISU_SIDEBAR_DRAG_TYPE } from "./dragTypes";

export function initHotkey() {
    document.addEventListener("keydown", async (ev) => {
        // The terminal notice is a modal dialog with its own keys: no shortcut runs behind it.
        if (get(terminalNotice) !== null) {
            return;
        }
        if (
            !ev.ctrlKey &&
            !ev.altKey &&
            !ev.shiftKey &&
            (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) ||
                document.activeElement.getAttribute("contenteditable"))
        ) {
            return;
        }

        const hotKeys = activeHotkeys(settings.hotkeys ?? defaultHotkeys, settings.ui);

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
                    if (get(doingChat) && selectedCharacter() !== undefined) {
                        return false;
                    }
                    alertWait("Loading...");
                    ev.preventDefault();
                    ev.stopPropagation();
                    await sendChat(-1, {
                        previewPrompt: true,
                    });

                    let md = "";
                    md += "### Prompt\n";
                    md +=
                        "```json\n" +
                        JSON.stringify(JSON.parse(previewBody), null, 2).replaceAll("```", "\\`\\`\\`") +
                        "\n```\n";
                    doingChat.set(false);
                    alertMd(md);
                    return;
                }
                case "toggleLog": {
                    alertRequestLogs();
                    break;
                }
                case "quickSettings": {
                    QuickSettings.open = !QuickSettings.open;
                    QuickSettings.index = 0;
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

        if (ev.ctrlKey) {
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
            if (doingAlert()) {
                alertToast("Alert Closed");
            }
            if (get(settingsOpen)) {
                settingsOpen.set(false);
            }
            ev.preventDefault();
        }
        if (ev.key === "Enter") {
            const alertType = get(alertStore).type;
            if (alertType === "ask" || alertType === "normal" || alertType === "error") {
                alertStore.set({
                    type: "none",
                    msg: "yes",
                });
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
 * The hotkeys in effect: `scrollToActiveChar` only while its feature is on. The stored list always
 * holds it (the server merges the built-in hotkeys back in), so the filter lives with the readers.
 */
export function activeHotkeys<T extends { action: string }>(
    hotkeys: T[],
    db: { enableScrollToActiveChar?: boolean } | undefined,
): T[] {
    return db?.enableScrollToActiveChar === false
        ? hotkeys.filter((hotkey) => hotkey.action !== "scrollToActiveChar")
        : hotkeys;
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
        if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return false;
    }
    return true;
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

function changeToPreset(num: number) {
    // The popup editor writes its draft back to the field it was opened on when it closes; with a
    // forwarded preset field that is the selected preset, so the selection must not change meanwhile.
    if (!doingAlert() && !popUpEditorStore.open) {
        let pres = settings.presets;
        if (pres.length > num) {
            alertToast(`Changed to Preset: ${pres[num].name}`);
            changeToPreset2(pres[num].id);
        }
    }
}
