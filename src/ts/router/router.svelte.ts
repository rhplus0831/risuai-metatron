import { untrack } from "svelte";
import { fromStore } from "svelte/store";
import { OpenRealmStore, PlaygroundStore } from "../stores.svelte";
import { findCharacter } from "../storage/characterStore.svelte";
import { ensureChat, selectChat, selectedChatId } from "../storage/chatStore.svelte";
import { characterIndex } from "../storage/records.svelte";
import { selectCharacter, selection } from "../storage/selection.svelte";
import { formatRoute, parseRoute, PLAYGROUND_TOOLS, playgroundToolOf, type Route } from "./routes";

/*
 * The router (`docs/plan/url-routes.md`, slice 3: the base routes). The stores stay the state: the
 * router applies a URL to them at boot and on every `popstate`, and a sync effect turns every
 * settled change of them into one history step (R1): a push, a replace, or a back when the target is
 * the entry directly beneath and the Navigation API lists it. The router does not track its own back
 * (decision 8): it waits for nothing, and the landing is applied like any other `popstate`. The
 * limits this leaves are the plan's accepted risks (A1–A7). The layers (settings, the character
 * grid) are slice 4: until then a layer URL is corrected to `/`, and an open layer does not change
 * the URL.
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
    /** Entries above the base route for a layer entry; 0 for a base route (always 0 until slice 4). */
    layerDepth: number;
};

/** The parts of the Navigation API the router uses (TypeScript's DOM library has no `Navigation` yet). */
export type NavigationLike = {
    readonly currentEntry: NavigationHistoryEntry | null;
    entries(): NavigationHistoryEntry[];
    traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
};

/** The playground chat's character (`PlaygroundMenu.svelte`). */
const PLAYGROUND_CHA_ID = "§playground";

const playground = fromStore(PlaygroundStore);
const realm = fromStore(OpenRealmStore);

function navigationApi(): NavigationLike | null {
    const navigation = (globalThis as { navigation?: Partial<NavigationLike> }).navigation;
    return navigation && typeof navigation.entries === "function" && typeof navigation.traverseTo === "function"
        ? (navigation as NavigationLike)
        : null;
}

/**
 * The browser's history. With the Navigation API (Chrome 102+, Firefox 147+, Safari 26.2+) the
 * router can see the entry beneath and go back to it; without it the router never goes back (A4).
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
    const { v, layerDepth } = raw as Partial<RouteState>;
    return v === 1 ? { v: 1, layerDepth: typeof layerDepth === "number" ? layerDepth : 0 } : null;
}

/** The base route the stores show (tracked). Layers are not routed yet. */
export function routeOfState(): Route {
    const chaId = selection.characterId;
    if (chaId !== null) {
        const chatId = selectedChatId(chaId);
        return chaId === PLAYGROUND_CHA_ID ? { kind: "playgroundChat", chatId } : { kind: "chat", chaId, chatId };
    }
    const value = playground.current;
    if (value === 0) {
        return realm.current ? { kind: "realm" } : { kind: "home" };
    }
    const tool = playgroundToolOf(value);
    return tool ? { kind: "playgroundTool", tool } : { kind: "playground" };
}

/** Sets the stores to show `route`. An id that names no record leaves the stores on a fallback the next sync writes back. */
function applyRoute(route: Route) {
    switch (route.kind) {
        case "chat":
        case "playgroundChat": {
            const chaId = route.kind === "chat" ? route.chaId : PLAYGROUND_CHA_ID;
            if (!findCharacter(chaId)) {
                // R4: a character that does not exist goes home.
                applyRoute({ kind: "home" });
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
            // Slice 4: the layers. Until then their URLs open home.
            applyRoute({ kind: "home" });
            return;
    }
}

/** Whether `route` shows a character that is gone (deleted here or by another client). */
function namesMissingCharacter(route: Route | null): boolean {
    if (route?.kind !== "chat" && route?.kind !== "playgroundChat") {
        return false;
    }
    return characterIndex(route.kind === "chat" ? route.chaId : PLAYGROUND_CHA_ID) === -1;
}

/** Whether moving from `from` (the current entry's route) to `to` replaces the entry instead of adding one (R1, R4). */
function replaces(from: Route | null, to: Route): boolean {
    if (from === null || from.kind === "characters" || from.kind === "settings") {
        return true;
    }
    // Switching chats within one character.
    return (
        (from.kind === "chat" && to.kind === "chat" && from.chaId === to.chaId) ||
        (from.kind === "playgroundChat" && to.kind === "playgroundChat")
    );
}

let port: HistoryPort | null = null;

/**
 * Writes the stores' route to the history: nothing when the entry already shows it; R4's replace
 * when its character is gone; a back when the target is the entry directly beneath (R1); R1's
 * chat-switch replace; else a push. `force` replaces (after applying a URL), which also writes the
 * canonical path without a query or hash.
 */
function sync(force = false) {
    if (!port) {
        return;
    }
    // The playground chat left without the menu (the Home hotkey clears only the selection): the
    // playground value 2 then shows an empty screen, so it shows the menu its URL names. Both values
    // are the route `/playground`, so the write does not run the sync effect again.
    if (untrack(() => selection.characterId === null && playground.current === 2)) {
        PlaygroundStore.set(1);
    }
    const next = untrack(routeOfState);
    const target = formatRoute(next);
    const from = parseRoute(port.path);
    const current = from ? formatRoute(from) : null;
    const stamped = readState(port.state);
    const state = stamped ?? { v: 1, layerDepth: 0 };
    // An entry the app did not write yet (the first one, a fragment change) gets its state here.
    if (force || !stamped) {
        port.replace(target, state);
        return;
    }
    if (target === current) {
        return;
    }
    if (untrack(() => namesMissingCharacter(from))) {
        // R4: the shown character was removed. When that left nothing selected (the membership hook),
        // the tab goes home; either way the removed character's entry is replaced.
        if (untrack(() => selection.characterId) === null) {
            applyRoute({ kind: "home" });
        }
        port.replace(formatRoute(untrack(routeOfState)), state);
        return;
    }
    const beneath = port.entryBelow(1);
    const beneathRoute = beneath ? parseRoute(beneath.path) : null;
    if (beneath && beneathRoute && formatRoute(beneathRoute) === target) {
        // Decision 8: the stores already show the target, and the landing is applied like any
        // `popstate`. A back that does nothing leaves the URL behind until the next change (A2).
        port.traverse(beneath.key);
        return;
    }
    if (untrack(() => replaces(from, next))) {
        port.replace(target, state);
        return;
    }
    port.push(target, { v: 1, layerDepth: 0 });
}

/** Every `popstate` is applied, the router's own back too (decision 8, A1, A6). */
function onPopState() {
    if (!port) {
        return;
    }
    applyRoute(parseRoute(port.path) ?? { kind: "home" });
    sync(true);
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
    applyRoute(parseRoute(port.path) ?? { kind: "home" });
    sync(true);
    const unsubscribePopState = port.onPopState(onPopState);
    const stopEffect = $effect.root(() => {
        // Only a change of the route takes a step (R2). A store change that keeps it (a chat list
        // reordered or updated from another tab) would otherwise start the same back again while the
        // URL is behind.
        const target = $derived(formatRoute(routeOfState()));
        $effect(() => {
            void target;
            untrack(() => sync());
        });
    });
    return () => {
        unsubscribePopState();
        stopEffect();
        port = null;
    };
}
