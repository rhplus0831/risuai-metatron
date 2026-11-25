import { language } from "src/lang";
import { alertNormal } from "./alert";
import { SafeModeStore } from "./stores.svelte";

/**
 * Safe boot: plugins, or custom CSS and GUI HTML, off for this page load.
 * Asked for with `?safe` (`?safe=all`, `?safe=plugins`, `?safe=css`, or a list), or entered by
 * itself after `SAFE_BOOT_THRESHOLD` consecutive boots that did not settle. Nothing is written to
 * the server and no persisted field changes: the state lives in this module for the page load, plus
 * one `localStorage` record of the boots that reached user content and did not settle.
 *
 * - Categories: `plugins` and `css` (custom CSS and custom GUI HTML, through `SafeModeStore`; the `toggleCSS` hotkey
 *   can turn them back on during a safe boot). A bare `?safe` and `?safe=all` mean both; `?safe=plugins`,
 *   `?safe=css`, or a comma list pick; unknown names are ignored. The query is read once, by `beginSafeBoot` at the
 *   start of `loadData`; the router's boot replace writes the path without it, so a reload after a settled boot
 *   starts normally.
 * - The counter: the record `SAFE_BOOT_KEY` = `{ count, at }`, read and written inside `try`. A failed or malformed
 *   read counts as no record, and a failed write leaves no counter for this boot (`?safe` still works). A boot counts
 *   only from its content stage, so one that fails earlier (an unreachable server, the service worker's reload) does
 *   not count.
 * - The trip: when the record this boot reads at its content stage holds `count >= SAFE_BOOT_THRESHOLD` and this
 *   boot's increment was written, both categories turn off before the theme runs. A failed write leaves only the
 *   `?safe` categories off, so a stale count cannot force later boots into safe mode while writes fail. Two boots
 *   that reached user content and did not settle make the third safe. A boot that settles removes only the record it
 *   wrote, so another tab's newer write or a storage error can leave one in place.
 * - The notice: one `alertNormal` at the content stage when anything is off, naming what is off, why when the
 *   counter tripped it, and how to leave. A boot that fails before its content stage with `?safe` categories already
 *   off shows it from its catch (`bootErrorWithSafeBootHint`).
 */

export type SafeBootCategory = "plugins" | "css";

/**
 * The `localStorage` key of the attempt record, the only thing safe boot persists. The tabs sharing this origin's
 * `localStorage` share it, and its read and write are not atomic.
 */
export const SAFE_BOOT_KEY = "risu.safeBoot.attempts";
/** Consecutive unsettled boots after which the next one is safe. */
export const SAFE_BOOT_THRESHOLD = 2;
/** How long a loaded page must stay up, with no failure and every plugin started, to count as settled. */
export const SAFE_BOOT_SETTLE_MS = 10_000;

const CATEGORIES: readonly SafeBootCategory[] = ["plugins", "css"];

/**
 * The categories `?safe` asks for, or null when the query has no `safe` parameter. A bare `safe` or
 * `all` means every category; unknown names are ignored.
 */
export function parseSafeFlag(search: string): Set<SafeBootCategory> | null {
    let params: URLSearchParams;
    try {
        params = new URLSearchParams(search);
    } catch {
        return null;
    }
    if (!params.has("safe")) {
        return null;
    }
    const names = params
        .getAll("safe")
        .flatMap((value) => value.split(","))
        .map((name) => name.trim().toLowerCase());
    if (names.every((name) => name === "") || names.includes("all")) {
        return new Set(CATEGORIES);
    }
    return new Set(CATEGORIES.filter((category) => names.includes(category)));
}

/** One counted attempt: how many boots in a row reached user content without settling, and when the last did. */
type AttemptRecord = { count: number; at: number };

function parseRecord(raw: string | null): AttemptRecord | null {
    if (raw === null) {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Number.isSafeInteger(value.count) &&
            value.count >= 0 &&
            typeof value.at === "number" &&
            Number.isFinite(value.at)
        ) {
            return { count: value.count, at: value.at };
        }
    } catch {}
    return null;
}

export type SafeBootDeps = {
    search(): string;
    /** May throw or return null; every use is guarded, and a failing store only loses the counter. */
    storage(): Storage | null;
    now(): number;
    setTimeout(run: () => void, ms: number): unknown;
    setCssOff(): void;
    notify(message: string): void;
};

export type SafeBoot = ReturnType<typeof createSafeBoot>;

/**
 * The safe-boot controller, with its effects injected through `SafeBootDeps` (the query, the storage, the clock, the
 * timer, `SafeModeStore`, the notice) so the tests run it. The module's own instance below does nothing until
 * `beginSafeBoot()`.
 */
export function createSafeBoot(deps: SafeBootDeps) {
    let begun = false;
    const off = new Set<SafeBootCategory>();
    let requested: Set<SafeBootCategory> | null = null;
    /** The unsettled boots before this one when they tripped safe boot (0: not tripped). */
    let tripped = 0;
    let counted = false;
    /** What this boot wrote at the content stage; only that record is cleared when it settles. */
    let written: string | null = null;
    let failed = false;
    let noticed = false;
    let windowStarted = false;
    let settled = false;

    function readRecord(): AttemptRecord | null {
        try {
            return parseRecord(deps.storage()?.getItem(SAFE_BOOT_KEY) ?? null);
        } catch {
            return null;
        }
    }

    function fail(reason: string) {
        if (!failed) {
            console.warn(`[Safe boot] This boot did not settle: ${reason}`);
        }
        failed = true;
    }

    function notice() {
        if (noticed || off.size === 0) {
            return;
        }
        noticed = true;
        const what = [
            off.has("plugins") ? language.safeBootPlugins : null,
            off.has("css") ? language.safeBootCss : null,
        ]
            .filter((text): text is string => text !== null)
            .join(", ");
        const lines = [language.safeBootNotice.replace("{off}", what)];
        if (tripped > 0) {
            lines.push(language.safeBootAutoReason.replace("{count}", String(tripped)));
        }
        lines.push(language.safeBootLeave);
        deps.notify(lines.join("\n\n"));
    }

    return {
        /**
         * Once per page load, before anything navigates (the router drops the query): reads `?safe`
         * and turns its categories off. Never throws.
         */
        begin() {
            if (begun) {
                return;
            }
            begun = true;
            try {
                requested = parseSafeFlag(deps.search());
            } catch {
                requested = null;
            }
            for (const category of requested ?? []) {
                off.add(category);
            }
            if (off.has("css")) {
                deps.setCssOff();
            }
        },
        isOff(category: SafeBootCategory): boolean {
            return off.has(category);
        },
        /**
         * Just before user content first runs (the theme, then the plugins): this boot counts as an
         * attempt until it settles, and the notice says what is off.
         */
        markContentStage() {
            if (counted) {
                return;
            }
            counted = true;
            // Use the current count: another tab may have counted or cleared during loading.
            const previous = readRecord();
            const record = JSON.stringify({
                count: Math.min((previous?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER),
                at: deps.now(),
            } satisfies AttemptRecord);
            try {
                const storage = deps.storage();
                if (storage) {
                    storage.setItem(SAFE_BOOT_KEY, record);
                    written = record;
                }
            } catch {
                written = null;
            }
            // A stale record cannot force safe boot when the counter cannot be written.
            if (written !== null && previous && previous.count >= SAFE_BOOT_THRESHOLD) {
                tripped = previous.count;
                for (const category of CATEGORIES) {
                    off.add(category);
                }
                deps.setCssOff();
            }
            notice();
        },
        /** Marks this boot as failed; nothing clears it in this page load. */
        fail,
        /**
         * Once `loadedStore` is true: the boot settles `SAFE_BOOT_SETTLE_MS` later if nothing failed by
         * then and every plugin it started reported its start (`guests`; true without plugins). A guest
         * that reports a failure fails the boot at once; one still silent at the end fails it then.
         */
        startSettleWindow(check: { loaded(): boolean; guests: Promise<boolean>; stopFollowingGuests?(): void }) {
            if (windowStarted) {
                return;
            }
            windowStarted = true;
            const deadline = deps.now() + SAFE_BOOT_SETTLE_MS;
            let guestsStarted = false;
            check.guests.then(
                (ok) => {
                    if (ok && deps.now() <= deadline) guestsStarted = true;
                    else fail("a plugin failed to start");
                },
                () => fail("a plugin failed to start"),
            );
            deps.setTimeout(() => {
                check.stopFollowingGuests?.();
                if (!guestsStarted) {
                    fail("a plugin did not report its start");
                }
                if (failed || !check.loaded()) {
                    return;
                }
                settled = true;
                if (written === null) {
                    return;
                }
                try {
                    const storage = deps.storage();
                    // Only this boot's own record: a newer attempt of another tab stays counted.
                    if (storage && storage.getItem(SAFE_BOOT_KEY) === written) {
                        storage.removeItem(SAFE_BOOT_KEY);
                    }
                } catch {}
            }, SAFE_BOOT_SETTLE_MS);
        },
        /** For the boot's error alert: shows the notice if the boot failed before its content stage. */
        noticeOnFailure: notice,
        /** Whether this boot settled (tests and diagnostics). */
        settled: () => settled,
        /** Whether this boot latched a failure (tests and diagnostics). */
        failed: () => failed,
    };
}

const safeBoot = createSafeBoot({
    search: () => globalThis.location?.search ?? "",
    storage: () => globalThis.localStorage ?? null,
    now: () => Date.now(),
    setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
    setCssOff: () => SafeModeStore.set(true),
    notify: (message) => alertNormal(message),
});

/** Reads `?safe` at the start of `loadData` (`src/ts/bootstrap.ts`), before anything can replace the URL. */
export const beginSafeBoot = () => safeBoot.begin();
/**
 * Whether `category` is off for this page load. `src/ts/plugins/plugins.svelte.ts` loads no plugin and runs no
 * deferred reload while `plugins` is off, and `src/lib/Setting/Pages/PluginSettings.svelte` says so.
 */
export const safeBootOff = (category: SafeBootCategory) => safeBoot.isOff(category);
/** Counts this boot and may trip safe boot; `loadData` calls it just before the theme (`updateTextThemeAndCSS`). */
export const markSafeBootContentStage = () => safeBoot.markContentStage();
/**
 * Fails this boot's attempt, so it never settles: `loadData` calls it for a rejected plugin load and in its catch.
 * A plugin that fails to start fails the attempt through the settle window's `guests`.
 */
export const latchSafeBootFailure = (reason: string) => safeBoot.fail(reason);
/**
 * Starts the settle window, once `loadData` has set `loadedStore`. A settled boot removes the attempt record only if
 * it still holds the value this boot wrote (compared by value), so another tab's newer attempt stays counted.
 */
export const startSafeBootSettleWindow = (check: {
    loaded(): boolean;
    guests: Promise<boolean>;
    stopFollowingGuests?(): void;
}) => safeBoot.startSettleWindow(check);

/** The address of a safe boot (home, both categories off). */
export function safeBootUrl(): string {
    try {
        return new URL("/?safe", globalThis.location.origin).href;
    } catch {
        return "/?safe";
    }
}

/**
 * What the boot's error alert shows: `error` with a line naming the safe-boot address. An Error keeps
 * its stack (a copy; the thrown one is not changed). Also shows the safe-boot notice if this boot had
 * categories off and failed before its content stage.
 */
export function bootErrorWithSafeBootHint(error: unknown): string | Error {
    safeBoot.noticeOnFailure();
    const hint = language.safeBootErrorHint.replace("{url}", safeBootUrl());
    if (error instanceof Error) {
        const copy = new Error(`${error.message}\n\n${hint}`);
        copy.stack = error.stack;
        return copy;
    }
    let text: string;
    if (typeof error === "string") {
        text = error;
    } else {
        try {
            text = JSON.stringify(error) ?? String(error);
        } catch {
            text = String(error);
        }
    }
    return `${text}\n\n${hint}`;
}
