import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("./globalApi.svelte", () => ({ globalFetch: vi.fn() }));

// Fake HTMLAudioElement. The observer only uses the constructor, volume, play(), pause(),
// error, and the "ended"/"error" events.
class AudioStub extends EventTarget {
    src: string;
    volume = 1;
    error: unknown = null;
    paused = true;
    constructor(src: string) {
        super();
        this.src = src;
        created.push(this);
    }
    play() {
        this.paused = false;
        return playImpl(this);
    }
    pause() {
        this.paused = true;
    }
}

const created: AudioStub[] = [];
let playImpl: (audio: AudioStub) => Promise<void> = () => Promise.resolve();
const userActivation = { hasBeenActive: true, isActive: true };
const clipboard = { writeText: vi.fn(() => Promise.resolve()) };

// happy-dom delivers mutation records through its own window timer, which vi.useFakeTimers does
// not control. Track the observers the module creates and deliver records explicitly instead.
const observers: { observer: MutationObserver; callback: MutationCallback }[] = [];
const NativeMutationObserver = globalThis.MutationObserver;
class TrackedMutationObserver extends NativeMutationObserver {
    constructor(callback: MutationCallback) {
        super(callback);
        observers.push({ observer: this, callback });
    }
}
const flushMutations = () => {
    for (const { observer, callback } of observers) {
        const records = observer.takeRecords();
        if (records.length > 0) {
            callback(records, observer);
        }
    }
};
// Deliver pending mutations, then let fake timers (the queued sync, grace timers) run
const tick = async (ms = 0) => {
    flushMutations();
    await vi.advanceTimersByTimeAsync(ms);
    flushMutations();
    await vi.advanceTimersByTimeAsync(0);
};
const bgm = (src: string, volume = "auto") => `<div risu-ctrl="bgm___${volume}___${src}"></div>`;
const rejectPlay = (name: string) => () => Promise.reject(new DOMException(name, name));
const srcs = () => created.map((a) => a.src);
const gesture = (type: "pointerup" | "keydown") => {
    const event =
        type === "keydown"
            ? new KeyboardEvent("keydown", { key: "a", bubbles: true })
            : new PointerEvent("pointerup", { bubbles: true });
    document.body.dispatchEvent(event);
};

// The module keeps its state in module scope and startObserveDom is idempotent, so one instance
// serves the whole file. Every test ends with the DOM empty and playback stopped.
let startObserveDom: () => void;

beforeAll(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", AudioStub);
    vi.stubGlobal("MutationObserver", TrackedMutationObserver);
    Object.defineProperty(navigator, "userActivation", { value: userActivation, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    ({ startObserveDom } = await import("./observer.svelte"));
    document.body.innerHTML = "";
    startObserveDom();
    await tick(10);
});

beforeEach(() => {
    created.length = 0;
    playImpl = () => Promise.resolve();
    userActivation.hasBeenActive = true;
    clipboard.writeText.mockClear();
});

afterEach(async () => {
    playImpl = () => Promise.resolve();
    document.body.innerHTML = "";
    // Let the stop grace expire and any failed marker become prunable
    await tick(2000);
    // Consume a pending autoplay retry, if any
    userActivation.hasBeenActive = true;
    gesture("pointerup");
    await tick(10);
});

describe("BGM marker parsing", () => {
    it("plays auto markers at half volume and keeps ___ inside the src", async () => {
        document.body.innerHTML = bgm("a___b___c.mp3");
        await tick(10);
        expect(srcs()).toEqual(["a___b___c.mp3"]);
        expect(created[0].volume).toBe(0.5);
        expect(created[0].paused).toBe(false);
    });

    it("clamps the volume into [0, 1] and falls back to 0.5 for garbage", async () => {
        document.body.innerHTML = bgm("loud.mp3", "2");
        await tick(10);
        expect(created[0].volume).toBe(1);
        document.body.innerHTML = "";
        await tick(2000);

        document.body.innerHTML = bgm("silent.mp3", "-1");
        await tick(10);
        expect(created[1].volume).toBe(0);
        document.body.innerHTML = "";
        await tick(2000);

        document.body.innerHTML = bgm("garbage.mp3", "abc");
        await tick(10);
        expect(created[2].volume).toBe(0.5);
    });

    it("ignores markers with no src and non-bgm risu-ctrl values", async () => {
        document.body.innerHTML = `<div risu-ctrl="bgm___auto"></div><div risu-ctrl="other___x___y"></div>`;
        await tick(10);
        expect(created).toHaveLength(0);
    });
});

describe("BGM selection and lifecycle", () => {
    it("starts the first marker in document order and keeps it when a newer marker appears", async () => {
        document.body.innerHTML = bgm("first.mp3") + bgm("second.mp3");
        await tick(10);
        expect(srcs()).toEqual(["first.mp3"]);

        document.body.insertAdjacentHTML("afterbegin", bgm("newest.mp3"));
        await tick(10);
        expect(srcs()).toEqual(["first.mp3"]);
        expect(created[0].paused).toBe(false);
    });

    it("replays after ended while the marker is still present", async () => {
        document.body.innerHTML = bgm("loop.mp3");
        await tick(10);
        created[0].dispatchEvent(new Event("ended"));
        await tick(10);
        expect(srcs()).toEqual(["loop.mp3", "loop.mp3"]);
        expect(created[1].paused).toBe(false);
    });

    it("survives a marker gap shorter than the stop grace", async () => {
        document.body.innerHTML = bgm("keep.mp3");
        await tick(10);
        document.body.innerHTML = "";
        await tick(500);
        document.body.innerHTML = bgm("keep.mp3");
        await tick(600);
        expect(srcs()).toEqual(["keep.mp3"]);
        expect(created[0].paused).toBe(false);
    });

    it("re-checks the DOM when the stop timer fires before the reinsert mutation is delivered", async () => {
        document.body.innerHTML = bgm("edge.mp3");
        await tick(10);
        document.body.innerHTML = "";
        await tick(990);
        // Reinsert just before the deadline, but let the stop timer fire before the mutation
        // record is delivered (the observer callback is a task of its own in browsers too)
        document.body.innerHTML = bgm("edge.mp3");
        await vi.advanceTimersByTimeAsync(20);
        expect(created[0].paused).toBe(false);
        await tick(10);
        expect(srcs()).toEqual(["edge.mp3"]);
        expect(created[0].paused).toBe(false);
    });

    it("stops after the grace period and starts another marker if one exists", async () => {
        document.body.innerHTML = bgm("old.mp3") + bgm("fallback.mp3");
        await tick(10);
        document.body.firstElementChild!.remove();
        await tick(1100);
        expect(created[0].paused).toBe(true);
        expect(srcs()).toEqual(["old.mp3", "fallback.mp3"]);
        expect(created[1].paused).toBe(false);
    });

    it("does nothing when a marker is removed and nothing replaces it", async () => {
        document.body.innerHTML = bgm("only.mp3");
        await tick(10);
        document.body.innerHTML = "";
        await tick(1100);
        expect(created[0].paused).toBe(true);
        expect(created).toHaveLength(1);
    });
});

describe("BGM source failures", () => {
    it("skips a marker whose play() rejects and moves on to the next marker", async () => {
        playImpl = (audio) => (audio.src === "dead.mp3" ? rejectPlay("NotSupportedError")() : Promise.resolve());
        document.body.innerHTML = bgm("dead.mp3") + bgm("ok.mp3");
        await tick(10);
        expect(srcs()).toEqual(["dead.mp3", "ok.mp3"]);
        expect(created[0].paused).toBe(true);
        expect(created[1].paused).toBe(false);
    });

    it("recovers from a media error after playback started", async () => {
        document.body.innerHTML = bgm("cuts-out.mp3") + bgm("ok.mp3");
        await tick(10);
        created[0].error = { code: 4 };
        created[0].dispatchEvent(new Event("error"));
        await tick(10);
        expect(srcs()).toEqual(["cuts-out.mp3", "ok.mp3"]);
        expect(created[0].paused).toBe(true);
    });

    it("does not retry a failed marker on gestures or unrelated DOM changes", async () => {
        playImpl = rejectPlay("NotSupportedError");
        document.body.innerHTML = bgm("dead.mp3") + `<textarea></textarea>`;
        await tick(10);
        expect(created).toHaveLength(1);

        for (let i = 0; i < 20; i++) {
            gesture("keydown");
            gesture("pointerup");
            await tick(10);
        }
        document.body.insertAdjacentHTML("beforeend", "<p>new message</p>");
        await tick(10);
        expect(created).toHaveLength(1);
    });

    it("keeps a failed marker suppressed across a short re-render gap", async () => {
        playImpl = rejectPlay("NotSupportedError");
        document.body.innerHTML = bgm("dead.mp3");
        await tick(10);
        for (let i = 0; i < 5; i++) {
            document.body.innerHTML = "";
            await tick(200);
            document.body.innerHTML = bgm("dead.mp3");
            await tick(200);
        }
        expect(created).toHaveLength(1);
    });

    it("retries a failed marker once when it comes back after a long absence", async () => {
        playImpl = rejectPlay("NotSupportedError");
        document.body.innerHTML = bgm("dead.mp3");
        await tick(10);
        document.body.innerHTML = "";
        await tick(1200);
        document.body.innerHTML = bgm("dead.mp3");
        await tick(10);
        expect(created).toHaveLength(2);
        gesture("pointerup");
        await tick(10);
        expect(created).toHaveLength(2);
    });

    it("does not treat play() rejection of a stopped audio as a failure", async () => {
        let reject: (e: unknown) => void = () => {};
        playImpl = () => new Promise<void>((_, r) => (reject = r));
        document.body.innerHTML = bgm("slow.mp3");
        await tick(10);
        // The marker leaves, the grace stop pauses the pending audio, and play() aborts
        document.body.innerHTML = "";
        await tick(1100);
        expect(created[0].paused).toBe(true);
        reject(new DOMException("interrupted", "AbortError"));
        await tick(10);

        playImpl = () => Promise.resolve();
        document.body.innerHTML = bgm("slow.mp3");
        await tick(10);
        expect(srcs()).toEqual(["slow.mp3", "slow.mp3"]);
        expect(created[1].paused).toBe(false);
    });
});

describe("BGM autoplay block", () => {
    it("waits for an activating gesture, then retries once", async () => {
        let allowed = false;
        playImpl = (audio) => (allowed ? Promise.resolve() : rejectPlay("NotAllowedError")());
        document.body.innerHTML = bgm("blocked.mp3") + bgm("other.mp3");
        await tick(10);
        // Autoplay blocks every source, so the second marker is not tried
        expect(srcs()).toEqual(["blocked.mp3"]);

        document.body.insertAdjacentHTML("beforeend", "<p>new message</p>");
        await tick(10);
        expect(created).toHaveLength(1);

        // A key that grants no activation (Escape-like) keeps waiting
        userActivation.hasBeenActive = false;
        gesture("keydown");
        await tick(10);
        expect(created).toHaveLength(1);

        allowed = true;
        userActivation.hasBeenActive = true;
        gesture("pointerup");
        await tick(10);
        expect(srcs()).toEqual(["blocked.mp3", "blocked.mp3"]);
        expect(created[1].paused).toBe(false);

        gesture("pointerup");
        gesture("keydown");
        await tick(10);
        expect(created).toHaveLength(2);
    });

    it("re-arms the gesture retry when the retry is blocked again", async () => {
        let allowed = false;
        playImpl = (audio) => (allowed ? Promise.resolve() : rejectPlay("NotAllowedError")());
        document.body.innerHTML = bgm("blocked.mp3");
        await tick(10);
        gesture("pointerup");
        await tick(10);
        expect(created).toHaveLength(2);

        allowed = true;
        gesture("pointerup");
        await tick(10);
        expect(created).toHaveLength(3);
        expect(created[2].paused).toBe(false);
    });
});

describe("code block context menu", () => {
    const rightClick = (target: Element) => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
        target.dispatchEvent(event);
        return event;
    };
    const menus = () => document.querySelectorAll("#code-contextmenu");

    it("opens one menu for a right-click inside a highlighted block, and closes it on click", async () => {
        document.body.innerHTML = `<pre x-hl-lang="ts"><code><span id="tok">const a = 1;</span></code></pre>`;
        const token = document.getElementById("tok")!;
        const event = rightClick(token);
        expect(event.defaultPrevented).toBe(true);
        rightClick(token);
        rightClick(token);
        expect(menus()).toHaveLength(1);
        const menu = menus()[0] as HTMLElement;
        expect(menu.style.left).toBe("12px");
        expect(menu.style.top).toBe("34px");

        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(menus()).toHaveLength(0);
    });

    it("ignores right-clicks outside highlighted blocks", () => {
        document.body.innerHTML = `<p id="plain">text</p>`;
        const event = rightClick(document.getElementById("plain")!);
        expect(event.defaultPrevented).toBe(false);
        expect(menus()).toHaveLength(0);
    });

    it("copies the block text and survives a clipboard rejection", async () => {
        clipboard.writeText.mockImplementationOnce(() => Promise.reject(new Error("denied")));
        document.body.innerHTML = `<pre x-hl-lang="py"><code>print(1)</code></pre>`;
        rightClick(document.querySelector("code")!);
        const copy = [...menus()[0].children].find((c) => c.textContent === "Copy") as HTMLElement;
        copy.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await tick(10);
        expect(clipboard.writeText).toHaveBeenCalledWith("print(1)");
        expect(menus()).toHaveLength(0);
    });

    it("does not register listeners twice when started again", () => {
        const spy = vi.spyOn(document, "addEventListener");
        startObserveDom();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
