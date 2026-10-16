// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Observe document-wide scans (the costly boundary), as well as playback for marker changes.
const audio: AudioStub[] = [];
class AudioStub extends EventTarget {
    volume = 1;
    paused = true;
    error = null;
    constructor(readonly src: string) {
        super();
        audio.push(this);
    }
    play() {
        this.paused = false;
        return Promise.resolve();
    }
    pause() {
        this.paused = true;
    }
}
const observers: { observer: MutationObserver; callback: MutationCallback }[] = [];
const NativeMutationObserver = globalThis.MutationObserver;
class TrackedMutationObserver extends NativeMutationObserver {
    constructor(callback: MutationCallback) {
        super(callback);
        observers.push({ observer: this, callback });
    }
}
async function settle(ms = 0) {
    // happy-dom's own mutation timer is not controlled by vi.useFakeTimers.
    for (const { observer, callback } of observers) {
        const records = observer.takeRecords();
        if (records.length) callback(records, observer);
    }
    await vi.advanceTimersByTimeAsync(ms);
}
let scan: ReturnType<typeof vi.spyOn>;
const markerScans = () => scan.mock.calls.filter(([selector]) => selector === "[risu-ctrl]");
const marker = () => {
    const element = document.createElement("div");
    element.setAttribute("risu-ctrl", "bgm___auto___music.mp3");
    return element;
};

beforeAll(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", AudioStub);
    vi.stubGlobal("MutationObserver", TrackedMutationObserver);
    const { startObserveDom } = await import("./observer.svelte");
    startObserveDom();
    await settle();
    scan = vi.spyOn(document, "querySelectorAll");
});
afterEach(async () => {
    document.body.replaceChildren();
    await settle(1100);
    audio.length = 0;
    scan.mockClear();
});
afterAll(() => {
    for (const { observer } of observers) observer.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("BGM mutation filtering", () => {
    it("does not scan markers for streamed text or plain HTML changes", async () => {
        const paragraph = document.createElement("p");
        paragraph.textContent = "first chunk";
        document.body.append(paragraph);
        await settle();
        paragraph.firstChild!.textContent = "second chunk";
        await settle();
        paragraph.innerHTML = "<b>formatted chunk</b><span>more text</span>";
        await settle();
        paragraph.className = "far";
        paragraph.style.color = "red";
        await settle();
        paragraph.replaceChildren(document.createTextNode("replacement text"));
        await settle();
        paragraph.remove();
        await settle();
        expect(markerScans()).toEqual([]);
        expect(audio).toHaveLength(0);
    });

    it.each([false, true])("rescans when an added or removed element carries a marker (nested %s)", async (nested) => {
        const control = marker();
        const subtree = nested ? document.createElement("section") : control;
        if (nested) subtree.append(control);
        document.body.append(subtree);
        await settle();
        expect(markerScans()).toHaveLength(1);
        expect(audio.map((item) => item.src)).toEqual(["music.mp3"]);
        expect(audio[0].paused).toBe(false);
        scan.mockClear();
        subtree.remove();
        await settle();
        expect(markerScans()).toHaveLength(1);
        await settle(1100);
        expect(audio[0].paused).toBe(true);
    });

    it("rescans when risu-ctrl is added, changed or removed on an existing element", async () => {
        const element = document.createElement("div");
        document.body.append(element);
        await settle();
        scan.mockClear();
        element.setAttribute("risu-ctrl", "bgm___auto___first.mp3");
        await settle();
        expect(markerScans()).toHaveLength(1);
        expect(audio.map((item) => item.src)).toEqual(["first.mp3"]);
        scan.mockClear();
        element.setAttribute("risu-ctrl", "bgm___auto___second.mp3");
        await settle();
        expect(markerScans()).toHaveLength(1);
        await settle(1100);
        expect(audio[0].paused).toBe(true);
        expect(audio.at(-1)!.src).toBe("second.mp3");
        scan.mockClear();
        element.removeAttribute("risu-ctrl");
        await settle();
        expect(markerScans()).toHaveLength(1);
        await settle(1100);
        expect(audio.at(-1)!.paused).toBe(true);
    });
});
