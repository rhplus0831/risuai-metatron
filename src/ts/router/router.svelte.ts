import { untrack } from "svelte";
import { fromStore } from "svelte/store";
import { gridOpenStore, OpenRealmStore, PlaygroundStore, SettingsMenuIndex, settingsOpen } from "../stores.svelte";
import { MODEL_SETTINGS_MENU, PROMPT_SETTINGS_MENU } from "../settingsMenu";
import { findCharacter } from "../storage/characterStore.svelte";
import { ensureChat, selectChat, selectedChatId } from "../storage/chatStore.svelte";
import { characterIndex } from "../storage/records.svelte";
import { selectCharacter, selection, setChatOpen } from "../storage/selection.svelte";
import {
    formatRoute,
    parseRoute,
    PLAYGROUND_TOOLS,
    playgroundToolOf,
    SETTINGS_PAGES,
    settingsPageOf,
    type Route,
} from "./routes";

/*
 * The router. The stores stay the state: the router applies a URL to them at boot and on every
 * `popstate`, and a sync effect turns every settled change of them into one history step (R1): a
 * push, a replace, or a back when the target is an entry beneath and the Navigation API lists it.
 * The router does not track its own back: it waits for nothing, and the landing is applied like any
 * other `popstate`. The limits this leaves are accepted risks (A1–A7, noted where they apply).
 *
 * A layer (settings, the character grid) opens over a base route. Its entry state holds how many
 * entries it is above its base route (`layerDepth`) and that base (`base`), so a close goes back to
 * the base entry when the browser still lists it, and a reload restores the base under the layer.
 */

/** The window history as the router uses it; the tests pass a fake. */
export interface HistoryPort {
    /** The current entry's pathname (no query or hash), read live. */
    readonly path: string;
    /** The current entry's state, read live. */
    readonly state: unknown;
    /** Adds an entry with `path` and no query or hash. */
    push(path: string, state: RouteState): void;
    /** Replaces the current entry with `path` (dropping any query or hash) and `state`. */
    replace(path: string, state: RouteState): void;
    /**
     * The entry `steps` below the current one when the Navigation API lists it as an entry of this
     * document with a readable URL; else null (always null without the Navigation API). A hint: the
     * browser can drop the entry before a traversal reaches it (A2).
     */
    entryBelow(steps: number): { key: string; path: string } | null;
    /** Starts a traversal to the entry with `key`. Fire and forget: its landing comes as a `popstate`. */
    traverse(key: string): void;
    /** Subscribes to `popstate`; returns the removal. */
    onPopState(listener: () => void): () => void;
}

/** The state of an entry the app wrote; `history.state` survives a reload. */
export type RouteState = {
    v: 1;
    /** For a layer entry: how many entries above its base route (1 = directly on it); 0 for a base route. */
    layerDepth: number;
    /** For a layer entry: the base route under it, applied first on a reload. */
    base?: string;
    /**
     * For a layer entry: its base changed while the layer was open (R6), so the layer entries beneath
     * can name an older base, and the router does not go back to them.
     */
    rebased?: true;
    /**
     * For a layer entry opened without its base entry beneath (a link, a bookmark, an import at boot):
     * the base entry is still to be inserted under it at the first user activation (H1).
     */
    rootPending?: true;
};

/** The parts of the Navigation API the router uses (TypeScript's DOM library has no `Navigation` yet). */
export type NavigationLike = {
    readonly currentEntry: NavigationHistoryEntry | null;
    entries(): NavigationHistoryEntry[];
    traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
};

/** The playground chat's character (`PlaygroundMenu.svelte`). */
const PLAYGROUND_CHA_ID = "§playground";

/** From this width `Settings.svelte` shows the list and the page together; below it they are separate screens. */
const WIDE_SETTINGS_WIDTH = 700;

const playground = fromStore(PlaygroundStore);
const realm = fromStore(OpenRealmStore);
const settingsShown = fromStore(settingsOpen);
const settingsMenu = fromStore(SettingsMenuIndex);
const gridShown = fromStore(gridOpenStore);

function navigationApi(): NavigationLike | null {
    const navigation = (globalThis as { navigation?: Partial<NavigationLike> }).navigation;
    return navigation && typeof navigation.entries === "function" && typeof navigation.traverseTo === "function"
        ? (navigation as NavigationLike)
        : null;
}

/**
 * The browser's history. With the Navigation API (Chrome 102+, Firefox 147+, Safari 26.2+) the
 * router can see the entries beneath and go back to them; without it the router never goes back (A4).
 */
export function browserHistory(navigation: NavigationLike | null = navigationApi()): HistoryPort {
    return {
        get path() {
            return location.pathname;
        },
        get state() {
            return history.state;
        },
        push(path, state) {
            history.pushState(state, "", path);
        },
        replace(path, state) {
            history.replaceState(state, "", path);
        },
        entryBelow(steps) {
            const current = navigation?.currentEntry;
            if (!navigation || !current || current.index < steps) {
                return null;
            }
            const entry = navigation.entries()[current.index - steps];
            if (!entry || !entry.sameDocument || !entry.key || entry.url === null) {
                return null;
            }
            try {
                return { key: entry.key, path: new URL(entry.url).pathname };
            } catch {
                return null;
            }
        },
        traverse(key) {
            if (!navigation) {
                return;
            }
            try {
                const { committed, finished } = navigation.traverseTo(key);
                committed.catch(() => {});
                finished.catch(() => {});
            } catch {
                // The back did nothing; the URL catches up at the next store change (A2).
            }
        },
        onPopState(listener) {
            const handler = () => listener();
            window.addEventListener("popstate", handler);
            return () => window.removeEventListener("popstate", handler);
        },
    };
}

function readState(raw: unknown): RouteState | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const { v, layerDepth, base, rebased, rootPending } = raw as Partial<Record<keyof RouteState, unknown>>;
    if (v !== 1) {
        return null;
    }
    const state: RouteState = { v: 1, layerDepth: typeof layerDepth === "number" && layerDepth > 0 ? layerDepth : 0 };
    if (typeof base === "string") {
        state.base = base;
    }
    if (rebased === true) {
        state.rebased = true;
    }
    if (rootPending === true) {
        state.rootPending = true;
    }
    return state;
}

const BASE_STATE: RouteState = { v: 1, layerDepth: 0 };

function layerState(layerDepth: number, base: string, flags: { rebased?: boolean; rootPending?: boolean } = {}) {
    const state: RouteState = { v: 1, layerDepth, base };
    if (flags.rebased) {
        state.rebased = true;
    }
    if (flags.rootPending) {
        state.rootPending = true;
    }
    return state;
}

function isLayer(route: Route | null): route is Extract<Route, { kind: "characters" | "settings" }> {
    return route?.kind === "characters" || route?.kind === "settings";
}

function wideSettings(): boolean {
    return window.innerWidth >= WIDE_SETTINGS_WIDTH;
}

/** The canonical path of `path` (null when it names no route). */
function canonical(path: string): string | null {
    const route = parseRoute(path);
    return route ? formatRoute(route) : null;
}

/**
 * The base route the stores show (tracked). A character whose chat is not open (`selection.chatOpen`)
 * is `/chat/:chaId`, its closed-chat screen; the playground chat is always open.
 */
export function baseRouteOfState(): Route {
    const chaId = selection.characterId;
    if (chaId === PLAYGROUND_CHA_ID) {
        return { kind: "playgroundChat", chatId: selectedChatId(chaId) };
    }
    if (chaId !== null) {
        return { kind: "chat", chaId, chatId: selection.chatOpen ? selectedChatId(chaId) : null };
    }
    const value = playground.current;
    if (value === 0) {
        return realm.current ? { kind: "realm" } : { kind: "home" };
    }
    const tool = playgroundToolOf(value);
    return tool ? { kind: "playgroundTool", tool } : { kind: "playground" };
}

/**
 * The layer the stores show over the base route (tracked); null when none. Settings wins over the
 * grid, as in `App.svelte`. The settings list on a wide screen is the model page (R4's canonical form),
 * and an index without a slug is the list.
 */
export function layerRouteOfState(): Route | null {
    if (settingsShown.current) {
        const index = settingsMenu.current;
        return { kind: "settings", page: index === -1 && wideSettings() ? "model" : settingsPageOf(index) };
    }
    return gridShown.current ? { kind: "characters" } : null;
}

/**
 * Store corrections that keep the route, so they take no history step: the playground value 2 with
 * nothing selected (the Home hotkey from the playground chat clears only the selection, which left an
 * empty screen) shows the menu its URL names; the settings list on a wide screen shows the model page
 * (`Settings.svelte` picks it itself only from 900 px, at mount); and open settings closes the grid
 * under it (R3: one layer at a time, so closing settings and going back both show the base route).
 */
function normalize() {
    if (selection.characterId === null && playground.current === 2) {
        PlaygroundStore.set(1);
    }
    if (settingsShown.current) {
        if (settingsMenu.current === -1 && wideSettings()) {
            SettingsMenuIndex.set(MODEL_SETTINGS_MENU);
        }
        if (gridShown.current) {
            gridOpenStore.set(false);
        }
    }
}

/** Sets the stores to show the base route `route`; the layers are left as they are. */
function applyBase(route: Route) {
    switch (route.kind) {
        case "chat":
        case "playgroundChat": {
            const chaId = route.kind === "chat" ? route.chaId : PLAYGROUND_CHA_ID;
            if (!findCharacter(chaId)) {
                // R4: a character that does not exist goes home.
                applyBase({ kind: "home" });
                return;
            }
            ensureChat(chaId);
            if (route.chatId !== null) {
                // Before the selection, so selecting loads this chat and not the previous one.
                selectChat(chaId, route.chatId);
            }
            PlaygroundStore.set(chaId === PLAYGROUND_CHA_ID ? 2 : 0);
            OpenRealmStore.set(false);
            selectCharacter(chaId);
            // After the selection, which closes the chat of a newly selected character.
            setChatOpen(route.kind === "chat" && route.chatId !== null);
            return;
        }
        case "realm":
        case "home":
            selectCharacter(null);
            PlaygroundStore.set(0);
            OpenRealmStore.set(route.kind === "realm");
            return;
        case "playground":
        case "playgroundTool":
            selectCharacter(null);
            PlaygroundStore.set(route.kind === "playground" ? 1 : PLAYGROUND_TOOLS[route.tool]);
            OpenRealmStore.set(false);
            return;
        case "characters":
        case "settings":
            // Not a base route: home (R4).
            applyBase({ kind: "home" });
            return;
    }
}

/** Opens the layer `route` (or closes both layers for null). */
function applyLayer(route: Route | null) {
    if (route?.kind === "settings") {
        SettingsMenuIndex.set(
            route.page !== null ? SETTINGS_PAGES[route.page] : wideSettings() ? MODEL_SETTINGS_MENU : -1,
        );
        settingsOpen.set(true);
        gridOpenStore.set(false);
        return;
    }
    settingsOpen.set(false);
    gridOpenStore.set(route?.kind === "characters");
}

/**
 * Applies the current entry to the stores. A layer entry applies its `base` first, so pages that
 * read the selected character see the right one. A layer URL without a readable base (a link, a
 * bookmark, an address-bar fragment change) applies home at boot and keeps the stores' base at a
 * `popstate`. At boot a base URL leaves the layers as they are: only an import that finished before
 * the router started can have opened one, and it stays open over that base.
 */
function applyEntry(boot: boolean) {
    const route = parseRoute(port!.path);
    if (!isLayer(route)) {
        applyBase(route ?? { kind: "home" });
        if (!boot) {
            applyLayer(null);
        }
        return;
    }
    const state = readState(port!.state);
    const base = state && state.layerDepth > 0 && state.base !== undefined ? parseRoute(state.base) : null;
    if (base && !isLayer(base)) {
        applyBase(base);
    } else if (boot) {
        applyBase({ kind: "home" });
    }
    applyLayer(route);
}

/** Whether the base route `route` shows a character that is gone (deleted here or by another client). */
function namesMissingCharacter(route: Route | null): boolean {
    if (route?.kind !== "chat" && route?.kind !== "playgroundChat") {
        return false;
    }
    return characterIndex(route.kind === "chat" ? route.chaId : PLAYGROUND_CHA_ID) === -1;
}

/** Whether moving between base routes from `from` (the current entry's route) to `to` replaces the entry instead of adding one (R1). */
function replaces(from: Route | null, to: Route): boolean {
    if (from === null) {
        return true;
    }
    // Switching chats within one character (opening or closing its chat is a step of its own).
    return (
        (from.kind === "chat" &&
            to.kind === "chat" &&
            from.chaId === to.chaId &&
            from.chatId !== null &&
            to.chatId !== null) ||
        (from.kind === "playgroundChat" && to.kind === "playgroundChat")
    );
}

/** Whether a move inside settings from `from` to `to` adds an entry (R1): the mobile list → a page, and the prompt preset → its template. */
function pushesInSettings(from: Route, to: Route): boolean {
    if (from.kind !== "settings" || to.kind !== "settings") {
        return false;
    }
    return (
        (from.page === null && to.page !== null && !wideSettings()) ||
        (from.page === "prompt" && to.page === "prompt-template")
    );
}

let port: HistoryPort | null = null;

/**
 * Adds the entries of a layer opened over the base entry beneath: on a narrow screen a settings page
 * gets the list under it, so the page's close goes back to the list.
 */
function pushLayer(layer: Route, base: string) {
    if (layer.kind === "settings" && layer.page !== null && !wideSettings()) {
        port!.push(formatRoute({ kind: "settings", page: null }), layerState(1, base));
        port!.push(formatRoute(layer), layerState(2, base));
        return;
    }
    port!.push(formatRoute(layer), layerState(1, base));
}

/**
 * Writes the stores' route to the history. `force` replaces (after applying a URL), which also
 * writes the canonical path without a query or hash. Otherwise, by the current entry:
 * - a layer entry: nothing when it already shows the target (R6: a changed base is written into the
 *   entry); a close goes back to the base entry `layerDepth` beneath when the browser lists it with
 *   the base the stores show, else replaces with that base; a move inside the layer goes back to the
 *   entry beneath when it shows the target and has the same base, pushes for R1's in-settings
 *   pushes, else replaces (R3's settings ↔ grid switch too).
 * - a base entry: a layer opens with a push; between base routes, nothing when the entry already
 *   shows it, R4's replace when its character is gone, a back when the target is the entry beneath,
 *   R1's chat-switch replace, else a push.
 * `landed` (a `popstate`) marks a layer entry above depth 1 `rebased`: while it was a forward entry,
 * R6 can have changed the base of the layer entries beneath, and their state cannot be read.
 */
function sync(force = false, landed = false) {
    if (!port) {
        return;
    }
    if (!force) {
        // R4 under a layer: the base of the layer entry names a removed character, and that left
        // nothing selected (the membership hook clears only the selection), so the base goes home as
        // it does without a layer. A character selected in the same step is kept.
        const shown = readState(port.state);
        const shownBase = shown?.base !== undefined && isLayer(parseRoute(port.path)) ? parseRoute(shown.base) : null;
        if (untrack(() => selection.characterId === null && namesMissingCharacter(shownBase))) {
            applyBase({ kind: "home" });
        }
    }
    const baseRoute = untrack(baseRouteOfState);
    const base = formatRoute(baseRoute);
    const layer = untrack(layerRouteOfState);
    const target = layer ? formatRoute(layer) : base;
    const from = parseRoute(port.path);
    const current = from ? formatRoute(from) : null;
    const entry = readState(port.state);
    // An entry the app did not write yet (the first one, a fragment change) gets its state here.
    if (force || !entry) {
        const rebased =
            entry?.rebased === true ||
            (entry?.base !== undefined && entry.base !== base) ||
            (landed && (entry?.layerDepth ?? 0) > 1);
        port.replace(
            target,
            layer
                ? layerState(Math.max(entry?.layerDepth ?? 0, 1), base, {
                      rebased,
                      rootPending: entry?.rootPending === true,
                  })
                : BASE_STATE,
        );
        return;
    }
    if (isLayer(from)) {
        syncFromLayer(from, current!, entry, target, base, layer);
        return;
    }
    if (layer) {
        pushLayer(layer, base);
        return;
    }
    if (target === current) {
        return;
    }
    if (untrack(() => namesMissingCharacter(from))) {
        // R4: the shown character was removed. When that left nothing selected (the membership hook),
        // the tab goes home; either way the removed character's entry is replaced.
        if (untrack(() => selection.characterId) === null) {
            applyBase({ kind: "home" });
        }
        port.replace(formatRoute(untrack(baseRouteOfState)), BASE_STATE);
        return;
    }
    const beneath = port.entryBelow(1);
    if (beneath && canonical(beneath.path) === target) {
        // The stores already show the target, and the landing is applied like any
        // `popstate`. A back that does nothing leaves the URL behind until the next change (A2).
        port.traverse(beneath.key);
        return;
    }
    if (untrack(() => replaces(from, baseRoute))) {
        port.replace(target, BASE_STATE);
        return;
    }
    port.push(target, BASE_STATE);
}

function syncFromLayer(
    from: Extract<Route, { kind: "characters" | "settings" }>,
    current: string,
    entry: RouteState,
    target: string,
    base: string,
    layer: Route | null,
) {
    const depth = Math.max(entry.layerDepth, 1);
    // R6: the base changed under the layer, now or earlier; the layer entries beneath can name the old one.
    const rebased = entry.rebased === true || entry.base !== base;
    const rootPending = entry.rootPending === true;
    if (target === current) {
        if (entry.base !== base) {
            port!.replace(target, layerState(depth, base, { rebased: true, rootPending }));
        }
        return;
    }
    if (!layer) {
        // The close: back to the base entry when the browser lists it with the base the stores show
        // (after R6 it does not), else the layer entry becomes the base entry.
        const below = port!.entryBelow(depth);
        if (below && canonical(below.path) === base) {
            port!.traverse(below.key);
            return;
        }
        port!.replace(base, BASE_STATE);
        return;
    }
    if (layer.kind !== from.kind) {
        // R3: one layer at a time; the other layer takes this entry.
        port!.replace(target, layerState(depth, base, { rebased, rootPending }));
        return;
    }
    if (depth > 1 && !rebased) {
        const below = port!.entryBelow(1);
        if (below && canonical(below.path) === target) {
            port!.traverse(below.key);
            return;
        }
    }
    if (pushesInSettings(from, layer)) {
        port!.push(target, layerState(depth + 1, base, { rebased }));
        return;
    }
    port!.replace(target, layerState(depth, base, { rebased, rootPending }));
}

/** Every `popstate` is applied, the router's own back too (A1, A6). */
function onPopState() {
    if (!port) {
        return;
    }
    stopRootInsertion();
    applyEntry(false);
    untrack(normalize);
    sync(true, true);
}

let removeActivationListeners: (() => void) | null = null;

/** The input events that give a user activation (HTML's activation-triggering input events), and `click`. */
const ACTIVATION_EVENTS = ["keydown", "mousedown", "pointerdown", "pointerup", "touchend", "click"] as const;

function givesActivation(event: Event): boolean {
    if (!event.isTrusted) {
        return false;
    }
    if (event.type === "keydown" && (event as KeyboardEvent).key === "Escape") {
        return false;
    }
    const pointerType = (event as PointerEvent).pointerType;
    if (event.type === "pointerdown" && pointerType !== "mouse") {
        return false;
    }
    if (event.type === "pointerup" && pointerType === "mouse") {
        return false;
    }
    const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
    return activation ? activation.isActive : true;
}

/**
 * Waits for the first user activation to insert the base entry under a layer entry with
 * `rootPending`. Pushed without an activation, the base entry would be skipped by the
 * browser's back button (H1). The listeners run in the capture phase on `window`, before the app's
 * own handlers, so a close made by the same click or key finds the base entry beneath.
 */
function startRootInsertion() {
    stopRootInsertion();
    const listener = (event: Event) => {
        if (givesActivation(event)) {
            insertRoot();
        }
    };
    for (const type of ACTIVATION_EVENTS) {
        window.addEventListener(type, listener, true);
    }
    removeActivationListeners = () => {
        for (const type of ACTIVATION_EVENTS) {
            window.removeEventListener(type, listener, true);
        }
    };
}

function stopRootInsertion() {
    removeActivationListeners?.();
    removeActivationListeners = null;
}

function insertRoot() {
    stopRootInsertion();
    if (!port) {
        return;
    }
    const entry = readState(port.state);
    const layer = parseRoute(port.path);
    if (!entry?.rootPending || !isLayer(layer)) {
        return;
    }
    const base = entry.base ?? formatRoute({ kind: "home" });
    port.replace(base, BASE_STATE);
    pushLayer(layer, base);
}

/** Ends the root insertion once the current entry no longer waits for it (a close, a push, a traversal's landing). */
function settleRootInsertion() {
    if (removeActivationListeners && !readState(port?.state)?.rootPending) {
        stopRootInsertion();
    }
}

/**
 * Shows the base route at `path` (a notification's chat): closes the layers and applies it to the
 * stores; the router's effect then pushes the URL. A path that is not a base route, or a call before
 * the router started, does nothing and returns false.
 */
export function openRoute(path: string): boolean {
    const route = parseRoute(path);
    if (!port || !route || isLayer(route)) {
        return false;
    }
    untrack(() => {
        applyLayer(null);
        applyBase(route);
    });
    return true;
}

/**
 * Starts the router (once, at the end of `loadData`): applies the current URL to the stores,
 * corrects the entry (R4), then follows the stores and `popstate`. Returns the stop (tests).
 */
export function startRouter(history?: HistoryPort): () => void {
    if (port) {
        return () => {};
    }
    // Created only after the guard, so a second call builds nothing.
    port = history ?? browserHistory();
    const before = readState(port.state);
    const wasLayer = isLayer(parseRoute(port.path));
    applyEntry(true);
    untrack(normalize);
    sync(true);
    // A layer shown at boot without its base entry beneath: a layer URL without state, an
    // entry that was still waiting before a reload, or an import's layer over a base URL.
    if (untrack(layerRouteOfState) && (!wasLayer || !before || before.rootPending)) {
        const entry = readState(port.state)!;
        port.replace(port.path, { ...entry, rootPending: true });
        startRootInsertion();
    }
    const unsubscribePopState = port.onPopState(onPopState);
    const stopEffect = $effect.root(() => {
        $effect(normalize);
        // Only a change of the route or of the base under a layer takes a step (R2, R6). A store
        // change that keeps both (a chat list reordered or updated from another tab, a normalization)
        // would otherwise start the same back again while the URL is behind.
        const key = $derived(
            `${formatRoute(layerRouteOfState() ?? baseRouteOfState())}\n${formatRoute(baseRouteOfState())}`,
        );
        $effect(() => {
            void key;
            untrack(() => {
                sync();
                settleRootInsertion();
            });
        });
    });
    return () => {
        unsubscribePopState();
        stopEffect();
        stopRootInsertion();
        port = null;
    };
}
