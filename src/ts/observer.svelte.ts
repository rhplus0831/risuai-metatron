// Grace period before stopping BGM whose marker left the DOM. Re-rendering a message can
// briefly remove its markers (remount, async re-parse) without meaning "stop the music".
const BGM_STOP_GRACE_MS = 1000;

let observingDom = false;
let codeContextMenu: HTMLElement | null = null;
let bgmElement: HTMLAudioElement | null = null;
let bgmMarker: string | null = null;
let bgmStopTimer: ReturnType<typeof setTimeout> | null = null;
let bgmSyncQueued = false;
// Cleared by the next activating user gesture, which retries playback
let bgmBlockedByAutoplay = false;
// Markers whose playback failed, mapped to when they went missing from the DOM (null while
// present). Skipped until missing for longer than BGM_STOP_GRACE_MS, so re-render gaps do not
// retry them but a marker that really comes back (chat switch, edit) gets one new attempt.
const bgmFailedMarkers = new Map<string, number | null>();
let bgmWaitingForGesture = false;

function closeCodeContextMenu() {
    codeContextMenu?.remove();
    codeContextMenu = null;
}

function onDocumentContextMenu(e: MouseEvent) {
    const node = e.target instanceof Element ? e.target.closest("[x-hl-lang]") : null;
    const hlLang = node?.getAttribute("x-hl-lang");
    if (!hlLang) {
        return;
    }
    e.preventDefault();
    closeCodeContextMenu();

    const menu = document.createElement("div");
    menu.id = "code-contextmenu";
    menu.setAttribute("class", "fixed z-50 min-w-[160px] py-2 bg-gray-800 rounded-lg border border-gray-700");

    const copyOption = document.createElement("div");
    copyOption.textContent = "Copy";
    copyOption.setAttribute("class", "px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer");
    copyOption.addEventListener("click", () => {
        navigator.clipboard.writeText(node.textContent).catch((error) => {
            console.error(error);
        });
        closeCodeContextMenu();
    });

    const downloadOption = document.createElement("div");
    downloadOption.textContent = "Download";
    downloadOption.setAttribute("class", "px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer");
    downloadOption.addEventListener("click", () => {
        const url = URL.createObjectURL(new Blob([node.textContent], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "code." + hlLang;
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 10000);
        closeCodeContextMenu();
    });

    menu.appendChild(copyOption);
    menu.appendChild(downloadOption);

    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";

    document.body.appendChild(menu);
    codeContextMenu = menu;
}

// Marker format: bgm___<volume|auto>___<src>. The src itself may contain "___".
function parseBgmMarker(marker: string) {
    const [kind, volumeText, ...srcParts] = marker.split("___");
    if (kind !== "bgm" || srcParts.length === 0) {
        return null;
    }
    const volume = volumeText === "auto" ? 0.5 : parseFloat(volumeText);
    return {
        // HTMLMediaElement.volume throws outside [0, 1]
        volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.5,
        src: srcParts.join("___"),
    };
}

function stopBgm() {
    if (bgmStopTimer) {
        clearTimeout(bgmStopTimer);
        bgmStopTimer = null;
    }
    const audio = bgmElement;
    bgmElement = null;
    bgmMarker = null;
    audio?.pause();
}

function retryBgmAfterGesture() {
    if (bgmWaitingForGesture) {
        return;
    }
    bgmWaitingForGesture = true;
    // pointerup, not pointerdown: touch and pen only grant user activation on release
    const resume = () => {
        // Keys such as Escape do not grant activation; keep waiting for one that does
        if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
            return;
        }
        document.removeEventListener("pointerup", resume, true);
        document.removeEventListener("keydown", resume, true);
        bgmWaitingForGesture = false;
        bgmBlockedByAutoplay = false;
        syncBgm();
    };
    document.addEventListener("pointerup", resume, true);
    document.addEventListener("keydown", resume, true);
}

function startBgm(marker: string, control: { volume: number; src: string }) {
    const audio = new Audio(control.src);
    audio.volume = control.volume;
    bgmElement = audio;
    bgmMarker = marker;
    audio.addEventListener("ended", () => {
        if (bgmElement !== audio) {
            return;
        }
        // Replays while a marker is still present
        stopBgm();
        syncBgm();
    });
    const fail = (error: unknown) => {
        if (bgmElement !== audio) {
            return;
        }
        console.warn("BGM playback failed:", error);
        stopBgm();
        // Autoplay blocks every source until a gesture. Any other failure is treated as specific
        // to this marker: retrying it on gestures would refetch a dead source on every keystroke,
        // so another marker may play instead.
        if (error instanceof DOMException && error.name === "NotAllowedError") {
            bgmBlockedByAutoplay = true;
            retryBgmAfterGesture();
        } else {
            bgmFailedMarkers.set(marker, null);
        }
        syncBgm();
    };
    audio.addEventListener("error", () => fail(audio.error));
    audio.play().catch(fail);
}

function collectBgmMarkers() {
    const markers: string[] = [];
    document.querySelectorAll("[risu-ctrl]").forEach((node) => {
        const marker = node.getAttribute("risu-ctrl");
        if (marker?.startsWith("bgm___")) {
            markers.push(marker);
        }
    });
    return markers;
}

function syncBgm() {
    const markers = collectBgmMarkers();
    const now = Date.now();
    for (const [marker, missingSince] of bgmFailedMarkers) {
        if (missingSince !== null && now - missingSince > BGM_STOP_GRACE_MS) {
            bgmFailedMarkers.delete(marker);
        } else if (markers.includes(marker)) {
            bgmFailedMarkers.set(marker, null);
        } else if (missingSince === null) {
            bgmFailedMarkers.set(marker, now);
        }
    }

    if (bgmElement) {
        if (markers.includes(bgmMarker)) {
            if (bgmStopTimer) {
                clearTimeout(bgmStopTimer);
                bgmStopTimer = null;
            }
        } else if (!bgmStopTimer) {
            bgmStopTimer = setTimeout(() => {
                bgmStopTimer = null;
                // The marker may have returned after the last sync was queued
                if (!collectBgmMarkers().includes(bgmMarker)) {
                    stopBgm();
                }
                syncBgm();
            }, BGM_STOP_GRACE_MS);
        }
        return;
    }

    if (bgmBlockedByAutoplay) {
        return;
    }

    // Document order: the chat body is column-reversed, so the newest message's marker comes first
    for (const marker of markers) {
        if (bgmFailedMarkers.has(marker)) {
            continue;
        }
        const control = parseBgmMarker(marker);
        if (control) {
            startBgm(marker, control);
            return;
        }
    }
}

function queueBgmSync() {
    if (bgmSyncQueued) {
        return;
    }
    bgmSyncQueued = true;
    // A macrotask lets a remove-then-insert re-render finish before markers are read
    setTimeout(() => {
        bgmSyncQueued = false;
        syncBgm();
    }, 0);
}

export function startObserveDom() {
    if (observingDom) {
        return;
    }
    observingDom = true;

    document.addEventListener("contextmenu", onDocumentContextMenu);
    document.addEventListener("click", closeCodeContextMenu);

    // Parsed message HTML (and its BGM markers) arrives through {@html}
    new MutationObserver(queueBgmSync).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["risu-ctrl"],
    });
    syncBgm();
}
