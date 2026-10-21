import { describe, expect, it, vi } from "vitest";

// Safe boot (`app-shell.md` Safe boot): the `?safe` flag, the attempt counter in `localStorage`,
// the failure latch, and the settle window, driven through `createSafeBoot` with every effect
// injected (the query, the store, the clock, the timer, the CSS switch, the notice). The default
// instance is used only for the error hint and the address.

vi.mock("./alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import {
    SAFE_BOOT_KEY,
    SAFE_BOOT_SETTLE_MS,
    SAFE_BOOT_THRESHOLD,
    bootErrorWithSafeBootHint,
    createSafeBoot,
    parseSafeFlag,
    safeBootUrl,
} from "./safeBoot";

const both = new Set(["plugins", "css"]);

/** A `Storage` over a map; each method can be made to throw. */
function memoryStorage(throwing: ("getItem" | "setItem" | "removeItem")[] = []) {
    const map = new Map<string, string>();
    const guard = (method: (typeof throwing)[number]) => {
        if (throwing.includes(method)) throw new DOMException("denied", "SecurityError");
    };
    return {
        map,
        getItem: (key: string) => (guard("getItem"), map.get(key) ?? null),
        setItem: (key: string, value: string) => (guard("setItem"), void map.set(key, value)),
        removeItem: (key: string) => (guard("removeItem"), void map.delete(key)),
    } as unknown as Storage & { map: Map<string, string> };
}

type Harness = ReturnType<typeof harness>;

function harness(options: { search?: string; storage?: Storage | null; store?: () => Storage | null } = {}) {
    const storage = options.storage === undefined ? memoryStorage() : options.storage;
    let now = 1_000;
    const timers: { run: () => void; ms: number }[] = [];
    const setCssOff = vi.fn();
    const notify = vi.fn<(message: string) => void>();
    const boot = createSafeBoot({
        search: () => options.search ?? "",
        storage: options.store ?? (() => storage),
        now: () => now,
        setTimeout: (run, ms) => timers.push({ run, ms }),
        setCssOff,
        notify,
    });
    return {
        boot,
        storage,
        timers,
        setCssOff,
        notify,
        advance: (ms: number) => void (now += ms),
        /** Runs the timers set so far. */
        fire: () => {
            for (const timer of timers.splice(0)) timer.run();
        },
        record: () => JSON.parse(storage?.getItem(SAFE_BOOT_KEY) ?? "null"),
        write: (count: number, at = 5) => storage?.setItem(SAFE_BOOT_KEY, JSON.stringify({ count, at })),
    };
}

/** Lets every queued microtask run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Starts the settle window and runs its timer `SAFE_BOOT_SETTLE_MS` later. */
async function settle(h: Harness, guests: Promise<boolean> = Promise.resolve(true), loaded = true) {
    h.boot.startSettleWindow({ loaded: () => loaded, guests });
    await flush();
    expect(h.timers.map((timer) => timer.ms)).toEqual([SAFE_BOOT_SETTLE_MS]);
    h.advance(SAFE_BOOT_SETTLE_MS);
    h.fire();
}

/** A boot that reached user content. */
function contentStage(h: Harness) {
    h.boot.begin();
    h.boot.markContentStage();
}

describe("parseSafeFlag", () => {
    it("is null without a safe parameter", () => {
        expect(parseSafeFlag("")).toBeNull();
        expect(parseSafeFlag("?other=1")).toBeNull();
    });

    it.each(["?safe", "?safe=", "?safe=all", "?safe=plugins,all"])("%s means every category", (search) => {
        expect(parseSafeFlag(search)).toEqual(both);
    });

    it("picks the named categories, case and spaces ignored, over commas or repeats", () => {
        expect(parseSafeFlag("?safe=plugins")).toEqual(new Set(["plugins"]));
        expect(parseSafeFlag("?safe=css")).toEqual(new Set(["css"]));
        expect(parseSafeFlag("?safe=plugins,css")).toEqual(both);
        expect(parseSafeFlag("?safe=plugins&safe=css")).toEqual(both);
        expect(parseSafeFlag("?safe=CSS,%20Plugins")).toEqual(both);
    });

    it("ignores unknown names", () => {
        expect(parseSafeFlag("?safe=foo")).toEqual(new Set());
        expect(parseSafeFlag("?safe=foo,css")).toEqual(new Set(["css"]));
    });
});

describe("the attempt counter", () => {
    it("writes nothing at begin and count 1 once at the content stage, before anything else", () => {
        const h = harness();
        h.boot.begin();
        expect(h.record()).toBeNull();
        h.boot.markContentStage();
        expect(h.record()).toEqual({ count: 1, at: 1_000 });
        h.boot.markContentStage();
        expect(h.record()).toEqual({ count: 1, at: 1_000 });
        expect(h.notify).not.toHaveBeenCalled();
    });

    it("counts on top of what the store holds when the content stage runs (another tab may have counted)", () => {
        const h = harness();
        h.boot.begin();
        h.write(1);
        h.boot.markContentStage();
        expect(h.record()).toMatchObject({ count: 2 });
    });

    it("removes its record once the loaded page stayed up for the window with every guest started", async () => {
        const h = harness();
        contentStage(h);
        h.boot.startSettleWindow({ loaded: () => true, guests: Promise.resolve(true) });
        await flush();
        expect(h.record()).toMatchObject({ count: 1 });
        expect(h.boot.settled()).toBe(false);
        h.advance(SAFE_BOOT_SETTLE_MS);
        h.fire();
        expect(h.record()).toBeNull();
        expect(h.boot.settled()).toBe(true);
        expect(h.boot.failed()).toBe(false);
    });

    it("keeps the record when the page is not loaded at the end of the window", async () => {
        const h = harness();
        contentStage(h);
        await settle(h, Promise.resolve(true), false);
        expect(h.record()).toMatchObject({ count: 1 });
        expect(h.boot.settled()).toBe(false);
    });

    it("clears only the record it wrote itself: a newer attempt of another tab stays", async () => {
        const h = harness();
        contentStage(h);
        const newer = JSON.stringify({ count: 2, at: 77 });
        h.storage!.setItem(SAFE_BOOT_KEY, newer);
        await settle(h);
        expect(h.boot.settled()).toBe(true);
        expect(h.storage!.getItem(SAFE_BOOT_KEY)).toBe(newer);
    });

    it("keeps the attempt counted after the window when the plugin load was rejected", async () => {
        const h = harness();
        contentStage(h);
        h.boot.fail("the plugins did not load");
        await settle(h, Promise.resolve(false));
        expect(h.record()).toMatchObject({ count: 1 });
        expect(h.boot.failed()).toBe(true);
        expect(h.boot.settled()).toBe(false);
    });

    it("keeps the attempt counted after the window when a guest never reports its start", async () => {
        const h = harness();
        contentStage(h);
        const stopFollowingGuests = vi.fn();
        h.boot.startSettleWindow({ loaded: () => true, guests: new Promise(() => {}), stopFollowingGuests });
        await flush();
        h.advance(SAFE_BOOT_SETTLE_MS);
        h.fire();
        expect(stopFollowingGuests).toHaveBeenCalledTimes(1);
        expect(h.boot.failed()).toBe(true);
        expect(h.record()).toMatchObject({ count: 1 });
    });

    it("fails the boot as soon as a guest reports a failed start", async () => {
        const h = harness();
        contentStage(h);
        h.boot.startSettleWindow({ loaded: () => true, guests: Promise.resolve(false) });
        await flush();
        expect(h.boot.failed()).toBe(true);
        h.advance(SAFE_BOOT_SETTLE_MS);
        h.fire();
        expect(h.record()).toMatchObject({ count: 1 });
    });

    it("accepts a guest ready within the window and refuses one ready after it, by the clock", async () => {
        const inTime = harness();
        contentStage(inTime);
        let ready!: (ok: boolean) => void;
        inTime.boot.startSettleWindow({ loaded: () => true, guests: new Promise((resolve) => (ready = resolve)) });
        inTime.advance(SAFE_BOOT_SETTLE_MS);
        ready(true);
        await flush();
        inTime.fire();
        expect(inTime.boot.settled()).toBe(true);

        const late = harness();
        contentStage(late);
        late.boot.startSettleWindow({ loaded: () => true, guests: new Promise((resolve) => (ready = resolve)) });
        late.advance(SAFE_BOOT_SETTLE_MS + 1);
        ready(true);
        await flush();
        late.fire();
        expect(late.boot.failed()).toBe(true);
        expect(late.boot.settled()).toBe(false);
        expect(late.record()).toMatchObject({ count: 1 });
    });

    it("keeps a failure latched after the window started (the loadData catch)", async () => {
        const h = harness();
        contentStage(h);
        h.boot.startSettleWindow({ loaded: () => true, guests: Promise.resolve(true) });
        await flush();
        h.boot.fail("the boot failed");
        h.advance(SAFE_BOOT_SETTLE_MS);
        h.fire();
        expect(h.boot.settled()).toBe(false);
        expect(h.record()).toMatchObject({ count: 1 });
    });

    it("starts one window only", () => {
        const h = harness();
        contentStage(h);
        h.boot.startSettleWindow({ loaded: () => true, guests: Promise.resolve(true) });
        h.boot.startSettleWindow({ loaded: () => true, guests: Promise.resolve(true) });
        expect(h.timers).toHaveLength(1);
    });
});

describe("the automatic safe boot", () => {
    it("trips at the threshold at the content stage, not at begin, and says why once", () => {
        const h = harness();
        h.write(SAFE_BOOT_THRESHOLD);
        h.boot.begin();
        expect(h.boot.isOff("plugins")).toBe(false);
        expect(h.boot.isOff("css")).toBe(false);
        expect(h.setCssOff).not.toHaveBeenCalled();
        h.boot.markContentStage();
        expect(h.boot.isOff("plugins")).toBe(true);
        expect(h.boot.isOff("css")).toBe(true);
        expect(h.setCssOff).toHaveBeenCalledTimes(1);
        expect(h.record()).toMatchObject({ count: SAFE_BOOT_THRESHOLD + 1 });
        expect(h.notify).toHaveBeenCalledTimes(1);
        const message = h.notify.mock.calls[0][0];
        expect(message).toContain(language.safeBootPlugins);
        expect(message).toContain(language.safeBootCss);
        expect(message).toContain(language.safeBootAutoReason.replace("{count}", String(SAFE_BOOT_THRESHOLD)));
        expect(message).toContain(language.safeBootLeave);
    });

    it("trips nothing below the threshold", () => {
        const h = harness();
        h.write(SAFE_BOOT_THRESHOLD - 1);
        contentStage(h);
        expect(h.boot.isOff("plugins")).toBe(false);
        expect(h.boot.isOff("css")).toBe(false);
        expect(h.notify).not.toHaveBeenCalled();
        expect(h.record()).toMatchObject({ count: SAFE_BOOT_THRESHOLD });
    });

    it("clears its record when it settles, so the next boot is normal", async () => {
        const storage = memoryStorage();
        const safe = harness({ storage });
        safe.write(SAFE_BOOT_THRESHOLD);
        contentStage(safe);
        await settle(safe);
        expect(safe.record()).toBeNull();

        const next = harness({ storage });
        contentStage(next);
        expect(next.boot.isOff("plugins")).toBe(false);
        expect(next.boot.isOff("css")).toBe(false);
        expect(next.record()).toMatchObject({ count: 1 });
    });

    it("does not trip while the counter cannot be written, so a stale count cannot trap later boots", () => {
        const storage = memoryStorage(["setItem"]);
        storage.map.set(SAFE_BOOT_KEY, JSON.stringify({ count: SAFE_BOOT_THRESHOLD, at: 5 }));
        // Two boots in a row on that store: neither can write, neither trips.
        for (let boot = 0; boot < 2; boot++) {
            const h = harness({ storage });
            contentStage(h);
            expect(h.boot.isOff("plugins")).toBe(false);
            expect(h.boot.isOff("css")).toBe(false);
            expect(h.setCssOff).not.toHaveBeenCalled();
            expect(h.notify).not.toHaveBeenCalled();
        }
    });
});

describe("the ?safe flag", () => {
    it("turns custom CSS off at begin (before the theme) and the notice names only what is off", () => {
        const h = harness({ search: "?safe=css" });
        h.boot.begin();
        expect(h.setCssOff).toHaveBeenCalledTimes(1);
        expect(h.boot.isOff("css")).toBe(true);
        expect(h.boot.isOff("plugins")).toBe(false);
        expect(h.notify).not.toHaveBeenCalled();
        h.boot.markContentStage();
        expect(h.notify).toHaveBeenCalledTimes(1);
        const message = h.notify.mock.calls[0][0];
        expect(message).toContain(language.safeBootCss);
        expect(message).not.toContain(language.safeBootPlugins);
        expect(message).not.toContain("did not finish loading");
        expect(message).toContain(language.safeBootLeave);
    });

    it("turns plugins off without touching the CSS", () => {
        const h = harness({ search: "?safe=plugins" });
        contentStage(h);
        expect(h.boot.isOff("plugins")).toBe(true);
        expect(h.boot.isOff("css")).toBe(false);
        expect(h.setCssOff).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenCalledTimes(1);
    });

    it("turns nothing off and shows no notice for unknown names only", () => {
        const h = harness({ search: "?safe=foo" });
        contentStage(h);
        expect(h.boot.isOff("plugins")).toBe(false);
        expect(h.boot.isOff("css")).toBe(false);
        expect(h.notify).not.toHaveBeenCalled();
    });

    it("shows one combined notice when the flag and the counter both apply", () => {
        const h = harness({ search: "?safe=plugins" });
        h.write(SAFE_BOOT_THRESHOLD);
        contentStage(h);
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(h.notify.mock.calls[0][0]).toContain(language.safeBootAutoReason.replace("{count}", "2"));
        expect(h.boot.isOff("css")).toBe(true);
    });

    it("shows the notice from the boot's catch when the boot failed before its content stage, once", () => {
        const h = harness({ search: "?safe" });
        h.boot.begin();
        h.boot.fail("the boot failed");
        h.boot.noticeOnFailure();
        expect(h.notify).toHaveBeenCalledTimes(1);
        h.boot.noticeOnFailure();
        h.boot.markContentStage();
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(h.record()).toMatchObject({ count: 1 });
    });

    it("shows nothing from the catch of a normal boot", () => {
        const h = harness();
        h.boot.begin();
        h.boot.noticeOnFailure();
        expect(h.notify).not.toHaveBeenCalled();
    });
});

describe("an unusable store", () => {
    it("leaves a normal boot without the counter when every access throws, and ?safe still works", async () => {
        const h = harness({ storage: memoryStorage(["getItem", "setItem", "removeItem"]), search: "?safe=plugins" });
        contentStage(h);
        expect(h.boot.isOff("plugins")).toBe(true);
        expect(h.boot.isOff("css")).toBe(false);
        expect(h.notify).toHaveBeenCalledTimes(1);
        await settle(h);
        expect(h.boot.settled()).toBe(true);
    });

    it("leaves a normal boot when the store is missing or its getter throws", async () => {
        const missing = harness({ storage: null });
        contentStage(missing);
        await settle(missing);
        expect(missing.boot.isOff("plugins")).toBe(false);
        expect(missing.boot.settled()).toBe(true);

        const throwing = harness({
            store: () => {
                throw new DOMException("denied", "SecurityError");
            },
        });
        contentStage(throwing);
        await settle(throwing);
        expect(throwing.boot.isOff("css")).toBe(false);
        expect(throwing.notify).not.toHaveBeenCalled();
        expect(throwing.boot.settled()).toBe(true);
    });

    it.each([
        "not json",
        "[]",
        "null",
        '{"count":"2","at":1}',
        '{"count":2}',
        '{"count":-1,"at":1}',
        '{"count":2.5,"at":1}',
        '{"count":2,"at":"x"}',
    ])("reads the malformed record %s as none", (raw) => {
        const h = harness();
        h.storage!.setItem(SAFE_BOOT_KEY, raw);
        contentStage(h);
        expect(h.boot.isOff("plugins")).toBe(false);
        expect(h.record()).toEqual({ count: 1, at: 1_000 });
    });
});

describe("the boot error's safe-boot hint", () => {
    const hint = () => language.safeBootErrorHint.replace("{url}", safeBootUrl());

    it("names this origin's /?safe", () => {
        expect(safeBootUrl()).toBe(`${location.origin}/?safe`);
    });

    it("copies an Error with the hint and the original stack, leaving the thrown one unchanged", () => {
        const thrown = new Error("boot broke");
        const shown = bootErrorWithSafeBootHint(thrown);
        expect(shown).toBeInstanceOf(Error);
        expect((shown as Error).message).toBe(`boot broke\n\n${hint()}`);
        expect((shown as Error).stack).toBe(thrown.stack);
        expect(thrown.message).toBe("boot broke");
    });

    it("appends the hint to a string and to a serialized object", () => {
        expect(bootErrorWithSafeBootHint("plain")).toBe(`plain\n\n${hint()}`);
        expect(bootErrorWithSafeBootHint({ code: 7 })).toBe(`{"code":7}\n\n${hint()}`);
        expect(bootErrorWithSafeBootHint(undefined)).toBe(`undefined\n\n${hint()}`);
    });
});
