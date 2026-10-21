import { flushSync } from "svelte";
import { get } from "svelte/store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";

// The router against a fake `HistoryPort`: boot with and without state, every `popstate` applied, the sync
// effect's history steps (push, the chat-switch replace, a back only to the confirmed entry beneath and never
// without the Navigation API), route corrections, a back that does nothing never retried, the
// URL catching up at the next change, the store corrections through the real effect rerun, and
// stop/restart. The layers (settings, the grid) with `layerDepth` and `base`, the close by depth and its
// replace fallback, the mobile list/page entries, layer switches, base changes and `rebased`, and the root insertion deferred to
// the first user activation (`rootPending`; the activation events are dispatched on happy-dom's window with
// `isTrusted` defined on the instance). The module graph is imported once (a reset graph would get its own
// Svelte runtime, and the effect would not see the stores), so each test starts the router on a fresh fake
// and stops it after. The browser adapter is checked at the end against happy-dom's history and a fake
// Navigation API.

vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { gridOpenStore, OpenRealmStore, PlaygroundStore, SettingsMenuIndex, settingsOpen } from "../stores.svelte";
import { MODEL_SETTINGS_MENU, PROMPT_SETTINGS_MENU } from "../settingsMenu";
import { characterList, removeCharacters } from "../storage/characterStore.svelte";
import * as chat from "../storage/chatStore.svelte";
import { initializeRecords, takeRecordFields } from "../storage/records.svelte";
import { selectCharacter, selection, setChatOpen } from "../storage/selection.svelte";
import { SETTINGS_PAGES } from "./routes";
import {
    browserHistory,
    type HistoryPort,
    type NavigationLike,
    openRoute,
    type RouteState,
    startRouter,
} from "./router.svelte";

const PLAYGROUND = "§playground";
const STATE: RouteState = { v: 1, layerDepth: 0 };
const MODEL = MODEL_SETTINGS_MENU;
const PROMPT = PROMPT_SETTINGS_MENU;
const TEMPLATE = SETTINGS_PAGES["prompt-template"];
const DISPLAY = SETTINGS_PAGES.display;
const HOME = "character=null chat=null playground=0 realm=false";
const CHAT_A = "character=a chat=a1 playground=0 realm=false";
const CHAT_B = "character=b chat=b1 playground=0 realm=false";
/** `window.innerWidth` below which `Settings.svelte` shows the list and a page as separate screens. */
const NARROW = 500;

/** The state of a layer entry `depth` above its base `base`. */
function layer(depth: number, base: string, flags: { rebased?: true; rootPending?: true } = {}): RouteState {
    return { v: 1, layerDepth: depth, base, ...flags };
}

type Entry = { key: string; path: string; state: unknown };

/**
 * A session history as the router sees it: the entries of this document, the current index, and
 * the Navigation API's view of the entry beneath (none without it). A traversal lands only when the
 * test says so (`land`), as the browser's does; `go` is the user's back or forward.
 */
class FakeHistory implements HistoryPort {
    entries: Entry[];
    index: number;
    navigation: boolean;
    /** Every history write and traversal, in order. */
    log: string[] = [];
    private listeners = new Set<() => void>();
    private keys = 0;

    constructor(paths: { path: string; state?: unknown }[], options: { navigation?: boolean; index?: number } = {}) {
        this.entries = paths.map(({ path, state }) => ({ key: this.nextKey(), path, state: state ?? null }));
        this.index = options.index ?? this.entries.length - 1;
        this.navigation = options.navigation ?? true;
    }

    private nextKey() {
        this.keys += 1;
        return `k${this.keys}`;
    }

    get path() {
        return this.entries[this.index].path;
    }

    get state() {
        return this.entries[this.index].state;
    }

    push(path: string, state: RouteState) {
        this.entries.splice(this.index + 1);
        this.entries.push({ key: this.nextKey(), path, state });
        this.index += 1;
        this.log.push(`push ${path}`);
    }

    replace(path: string, state: RouteState) {
        this.entries[this.index] = { ...this.entries[this.index], path, state };
        this.log.push(`replace ${path}`);
    }

    entryBelow(steps: number) {
        if (!this.navigation) {
            return null;
        }
        const entry = this.entries[this.index - steps];
        return entry ? { key: entry.key, path: entry.path } : null;
    }

    traverse(key: string) {
        this.log.push(`traverse ${key}`);
    }

    onPopState(listener: () => void) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** The key of the entry `steps` below the current one. */
    keyBelow(steps = 1) {
        return this.entries[this.index - steps].key;
    }

    /** The paths of the entries, with the current one marked. */
    paths() {
        return this.entries.map((entry, index) => (index === this.index ? `[${entry.path}]` : entry.path));
    }

    /** The landing of a traversal to `key`: the browser's `popstate`. */
    land(key: string) {
        const index = this.entries.findIndex((entry) => entry.key === key);
        if (index === -1) {
            throw new Error(`no entry ${key}`);
        }
        this.index = index;
        this.fire();
    }

    /** The user's back (`-1`) or forward (`1`). */
    go(delta: number) {
        this.index += delta;
        this.fire();
    }

    private fire() {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

let server: StoreBackedServer;
let stop: (() => void) | null = null;

/** Starts the router on `history`, flushes the effect's first run, and returns the port. */
function start(history: FakeHistory) {
    stop = startRouter(history);
    flushSync();
    return history;
}

/** The screen the stores show, in one string. */
function screen() {
    const chaId = selection.characterId;
    const chatId = chaId === null ? null : chat.selectedChatId(chaId);
    return `character=${chaId} chat=${chatId} playground=${get(PlaygroundStore)} realm=${get(OpenRealmStore)}`;
}

/** The layer the stores show, in one string. */
function layers() {
    return `settings=${get(settingsOpen)}:${get(SettingsMenuIndex)} grid=${get(gridOpenStore)}`;
}

/** Both layers closed, the settings index at the list. */
function resetLayers() {
    settingsOpen.set(false);
    SettingsMenuIndex.set(-1);
    gridOpenStore.set(false);
    flushSync();
}

/** An event as the browser dispatches it: happy-dom leaves `isTrusted` undefined on a constructed event. */
function trusted<T extends Event>(event: T): T {
    Object.defineProperty(event, "isTrusted", { value: true, configurable: true });
    return event;
}

/** A trusted click on the window (an activation for the root insertion). */
function click() {
    window.dispatchEvent(trusted(new MouseEvent("click")));
}

const create = (characterId: string, id: string, data = "A") => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [
        {
            op: "create",
            chat: {
                id,
                name: id,
                note: "",
                localLore: [],
                message: [{ role: "char", data, chatId: `${id}-m` }],
            } as any,
        },
    ],
});

beforeAll(async () => {
    server = await StoreBackedServer.create();
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [
            { kind: characters, id: "a", baseRevision: null, data: { chaId: "a", name: "A" } },
            { kind: characters, id: "b", baseRevision: null, data: { chaId: "b", name: "B" } },
            { kind: characters, id: PLAYGROUND, baseRevision: null, data: { chaId: PLAYGROUND, name: "Playground" } },
        ],
        chats: [create("a", "a1"), create("a", "a2"), create("b", "b1"), create(PLAYGROUND, "p1")],
    });
    const read = server.store.readKinds([characters], { chats: true });
    initializeRecords(takeRecordFields({ characters: read.kinds.characters.map((record) => record.data) }));
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(characterList() as any, read.chats!, read.chatOrders!);
    chat.initializeChats();
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The stores at home, the first chat selected for every character, no layer, a wide screen.
    selectCharacter(null);
    PlaygroundStore.set(0);
    OpenRealmStore.set(false);
    chat.selectChat("a", "a1");
    chat.selectChat("b", "b1");
    chat.selectChat(PLAYGROUND, "p1");
    window.innerWidth = 1024;
    resetLayers();
});

afterEach(() => {
    stop?.();
    stop = null;
    vi.restoreAllMocks();
});

describe("boot", () => {
    it("applies the URL of an entry without state and stamps it (a first load at home)", () => {
        const history = start(new FakeHistory([{ path: "/" }]));
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
        expect(history.log).toEqual(["replace /"]);
        expect(history.state).toEqual(STATE);
    });

    it("applies a chat URL of a stamped entry (a reload) and keeps the entry", () => {
        const history = start(new FakeHistory([{ path: "/" }, { path: "/chat/a/a2", state: STATE }]));
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(history.log).toEqual(["replace /chat/a/a2"]);
        expect(history.paths()).toEqual(["/", "[/chat/a/a2]"]);
    });

    it("applies the playground chat, the menu, a tool, and realm", () => {
        let history = start(new FakeHistory([{ path: "/playground/chat/p1" }]));
        expect(screen()).toBe(`character=${PLAYGROUND} chat=p1 playground=2 realm=false`);
        expect(history.log).toEqual(["replace /playground/chat/p1"]);
        stop!();

        history = start(new FakeHistory([{ path: "/playground" }]));
        expect(screen()).toBe("character=null chat=null playground=1 realm=false");
        expect(history.log).toEqual(["replace /playground"]);
        stop!();

        history = start(new FakeHistory([{ path: "/playground/tokenizer/" }]));
        expect(screen()).toBe("character=null chat=null playground=4 realm=false");
        // The canonical path, without the trailing slash.
        expect(history.log).toEqual(["replace /playground/tokenizer"]);
        stop!();

        history = start(new FakeHistory([{ path: "/realm" }]));
        expect(screen()).toBe("character=null chat=null playground=0 realm=true");
        expect(history.log).toEqual(["replace /realm"]);
    });

    it("applies /chat/:chaId as the closed chat, and falls back from an unknown chat id to the open selected chat", () => {
        chat.selectChat("a", "a2");
        let history = start(new FakeHistory([{ path: "/chat/a" }]));
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(selection.chatOpen).toBe(false);
        expect(history.log).toEqual(["replace /chat/a"]);
        stop!();

        history = start(new FakeHistory([{ path: "/chat/a/missing", state: STATE }]));
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(selection.chatOpen).toBe(true);
        expect(history.log).toEqual(["replace /chat/a/a2"]);
    });

    it("an unknown character, an unknown path, and an unknown settings slug go home", () => {
        for (const path of ["/chat/nobody/x", "/nonsense", "/settings/nope", "/playground/chat/p1"]) {
            if (path === "/playground/chat/p1") {
                // The playground character is checked like any other.
                removeCharacters([PLAYGROUND]);
            }
            const history = start(new FakeHistory([{ path, state: STATE }]));
            expect(screen(), path).toBe(HOME);
            expect(layers(), path).toBe("settings=false:-1 grid=false");
            expect(history.log, path).toEqual(["replace /"]);
            expect(history.state, path).toEqual(STATE);
            stop!();
        }
        restorePlayground();
    });

    it("starts once: a second start builds nothing, and the stop lets a new one start", () => {
        const first = start(new FakeHistory([{ path: "/" }]));
        const second = new FakeHistory([{ path: "/realm" }]);
        const noop = startRouter(second);
        flushSync();
        expect(second.log).toEqual([]);
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
        noop();
        // The first router is still running.
        selectCharacter("a");
        flushSync();
        expect(first.log).toEqual(["replace /", "push /chat/a"]);

        stop!();
        stop = null;
        // Stopped: neither a store change nor a popstate reaches the history.
        selectCharacter("b");
        flushSync();
        first.go(-1);
        expect(first.log).toEqual(["replace /", "push /chat/a"]);
        expect(screen()).toBe("character=b chat=b1 playground=0 realm=false");

        const third = start(new FakeHistory([{ path: "/realm" }]));
        expect(screen()).toBe("character=null chat=null playground=0 realm=true");
        expect(third.log).toEqual(["replace /realm"]);
    });
});

/** Puts the removed playground character back for the later tests. */
function restorePlayground() {
    const characters = server.kind("characters");
    const read = server.store.readKinds([characters], { chats: true });
    initializeRecords(takeRecordFields({ characters: read.kinds.characters.map((record) => record.data) }));
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(characterList() as any, read.chats!, read.chatOrders!);
    chat.initializeChats();
}

describe("the sync effect", () => {
    it("pushes a character switch, home to realm, the playground menu, and a tool", () => {
        // Without the Navigation API every step here is a push (realm to home would go back with it).
        const history = start(new FakeHistory([{ path: "/" }], { navigation: false }));
        selectCharacter("a");
        flushSync();
        selectCharacter("b");
        flushSync();
        selectCharacter(null);
        flushSync();
        OpenRealmStore.set(true);
        flushSync();
        OpenRealmStore.set(false);
        flushSync();
        PlaygroundStore.set(1);
        flushSync();
        PlaygroundStore.set(4);
        flushSync();
        expect(history.log).toEqual([
            "replace /",
            "push /chat/a",
            "push /chat/b",
            "push /",
            "push /realm",
            "push /",
            "push /playground",
            "push /playground/tokenizer",
        ]);
        expect(history.state).toEqual(STATE);
    });

    it("takes one step for a change that settles over several setters", () => {
        const history = start(new FakeHistory([{ path: "/" }, { path: "/chat/a/a1", state: STATE }]));
        // The sidebar's reseter: several stores in one handler.
        OpenRealmStore.set(false);
        PlaygroundStore.set(0);
        selectCharacter("b");
        chat.selectChat("b", "b1");
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", "push /chat/b"]);
    });

    it("replaces a chat switch within one character", () => {
        const history = start(new FakeHistory([{ path: "/" }, { path: "/chat/a/a1", state: STATE }]));
        chat.selectChat("a", "a2");
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", "replace /chat/a/a2"]);
        expect(history.paths()).toEqual(["/", "[/chat/a/a2]"]);
    });

    it("goes back when the target is the entry beneath, and applies the landing like any popstate", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/chat/a/a1", state: STATE },
            ]),
        );
        const below = history.keyBelow();
        selectCharacter(null);
        flushSync();
        // Nothing else: the stores already show the target, the URL waits for the landing.
        expect(history.log).toEqual(["replace /chat/a/a1", `traverse ${below}`]);
        expect(history.path).toBe("/chat/a/a1");
        history.land(below);
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", `traverse ${below}`, "replace /"]);
        expect(history.paths()).toEqual(["[/]", "/chat/a/a1"]);
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
    });

    it("goes back from a playground tool to the menu, and from realm to home", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/playground", state: STATE },
                { path: "/playground/tokenizer", state: STATE },
            ]),
        );
        PlaygroundStore.set(1);
        flushSync();
        expect(history.log).toEqual(["replace /playground/tokenizer", `traverse ${history.keyBelow()}`]);
        history.land(history.keyBelow());
        flushSync();
        PlaygroundStore.set(0);
        flushSync();
        expect(history.log.slice(2)).toEqual(["replace /playground", `traverse ${history.keyBelow()}`]);
        history.land(history.keyBelow());
        flushSync();
        expect(history.log.slice(4)).toEqual(["replace /"]);
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
    });

    it("pushes when the entry beneath is another route, or when there is no entry beneath", () => {
        let history = start(
            new FakeHistory([
                { path: "/realm", state: STATE },
                { path: "/chat/a/a1", state: STATE },
            ]),
        );
        selectCharacter(null);
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", "push /"]);
        stop!();

        history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }]));
        selectCharacter(null);
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", "push /"]);
    });

    it("never goes back without the Navigation API", () => {
        const history = start(
            new FakeHistory(
                [
                    { path: "/", state: STATE },
                    { path: "/chat/a/a1", state: STATE },
                ],
                { navigation: false },
            ),
        );
        selectCharacter(null);
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", "push /"]);
        expect(history.paths()).toEqual(["/", "/chat/a/a1", "[/]"]);
    });

    it("a back that does nothing is not retried; the URL catches up at the next change", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/chat/a/a1", state: STATE },
            ]),
        );
        const below = history.keyBelow();
        selectCharacter(null);
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", `traverse ${below}`]);
        // No landing comes. The effect is idle: nothing retries the back.
        flushSync();
        flushSync();
        expect(history.log).toHaveLength(2);
        expect(history.path).toBe("/chat/a/a1");
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
        // The next store change syncs from the URL the history really shows: a push over the stale entry.
        selectCharacter("b");
        flushSync();
        expect(history.log.slice(2)).toEqual(["push /chat/b"]);
        expect(history.paths()).toEqual(["/", "/chat/a/a1", "[/chat/b]"]);
    });

    it("sets the playground value 2 to 1 when the selection is cleared, and takes one back for it", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/playground", state: STATE },
                { path: "/playground/chat/p1", state: STATE },
            ]),
        );
        expect(screen()).toBe(`character=${PLAYGROUND} chat=p1 playground=2 realm=false`);
        const below = history.keyBelow();
        // The Home hotkey: only the selection is cleared, the playground value stays 2.
        selectCharacter(null);
        flushSync();
        expect(get(PlaygroundStore)).toBe(1);
        // The normalizing run takes exactly one back; the write keeps the route, so no rerun takes another.
        expect(history.log).toEqual(["replace /playground/chat/p1", `traverse ${below}`]);
        // The back does nothing: no retry.
        flushSync();
        expect(history.log).toHaveLength(2);
        // The next change catches up from the stale URL: the menu entry was never reached.
        PlaygroundStore.set(4);
        flushSync();
        expect(history.log.slice(2)).toEqual(["push /playground/tokenizer"]);
    });

    it("boots over a stale playground value 2 and lands a playground chat whose character is gone at home", () => {
        selectCharacter(null);
        PlaygroundStore.set(2);
        flushSync();
        const history = start(new FakeHistory([{ path: "/playground/chat/p1" }, { path: "/chat/a/a1", state: STATE }]));
        expect(screen()).toBe("character=a chat=a1 playground=0 realm=false");
        removeCharacters([PLAYGROUND]);
        history.go(-1);
        flushSync();
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
        expect(history.log).toEqual(["replace /chat/a/a1", "replace /"]);
        expect(history.paths()).toEqual(["[/]", "/chat/a/a1"]);
        restorePlayground();
    });
});

describe("the closed chat", () => {
    it("opens a chat with a push, replaces a switch while open, and closes with a back to /chat/:chaId", () => {
        const history = start(new FakeHistory([{ path: "/", state: STATE }]));
        selectCharacter("a");
        flushSync();
        expect(selection.chatOpen).toBe(false);
        setChatOpen(true);
        flushSync();
        chat.selectChat("a", "a2");
        flushSync();
        expect(history.log).toEqual(["replace /", "push /chat/a", "push /chat/a/a1", "replace /chat/a/a2"]);
        const below = history.keyBelow();
        // The sidebar's Go Back.
        setChatOpen(false);
        flushSync();
        expect(history.log.slice(4)).toEqual([`traverse ${below}`]);
        history.land(below);
        flushSync();
        expect(history.log.slice(5)).toEqual(["replace /chat/a"]);
        expect(selection.chatOpen).toBe(false);
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
    });

    it("applies the browser's back and forward between the closed and the open chat", () => {
        const history = start(
            new FakeHistory([
                { path: "/chat/a", state: STATE },
                { path: "/chat/a/a2", state: STATE },
            ]),
        );
        expect(selection.chatOpen).toBe(true);
        history.go(-1);
        flushSync();
        expect(selection.chatOpen).toBe(false);
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        history.go(1);
        flushSync();
        expect(selection.chatOpen).toBe(true);
        expect(history.log).toEqual(["replace /chat/a/a2", "replace /chat/a", "replace /chat/a/a2"]);
    });

    it("closes the chat when another character is selected, and keeps nothing open at home", () => {
        const history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }], { navigation: false }));
        selectCharacter("b");
        flushSync();
        expect(selection.chatOpen).toBe(false);
        selectCharacter(null);
        setChatOpen(true);
        flushSync();
        expect(selection.chatOpen).toBe(false);
        expect(history.log).toEqual(["replace /chat/a/a1", "push /chat/b", "push /"]);
    });

    it("pushes the close when the entry beneath is not the closed chat (a reload on the open chat)", () => {
        const history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }]));
        setChatOpen(false);
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", "push /chat/a"]);
    });

    it("leaves the playground chat open whatever the flag", () => {
        const history = start(new FakeHistory([{ path: "/playground/chat/p1", state: STATE }]));
        expect(selection.chatOpen).toBe(false);
        setChatOpen(true);
        flushSync();
        setChatOpen(false);
        flushSync();
        expect(history.log).toEqual(["replace /playground/chat/p1"]);
    });
});

describe("popstate", () => {
    it("applies every landing: the user's back and forward, with and without state", () => {
        const history = start(
            new FakeHistory([
                { path: "/" },
                { path: "/chat/a/a2", state: STATE },
                { path: "/playground/tokenizer", state: STATE },
                { path: "/chat/b/b1", state: STATE },
            ]),
        );
        expect(screen()).toBe("character=b chat=b1 playground=0 realm=false");
        history.go(-1);
        flushSync();
        expect(screen()).toBe("character=null chat=null playground=4 realm=false");
        history.go(-1);
        flushSync();
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        // An entry without state (from before the router) is applied and stamped.
        history.go(-1);
        flushSync();
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
        expect(history.state).toEqual(STATE);
        history.go(1);
        flushSync();
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(history.log).toEqual([
            "replace /chat/b/b1",
            "replace /playground/tokenizer",
            "replace /chat/a/a2",
            "replace /",
            "replace /chat/a/a2",
        ]);
        expect(history.paths()).toEqual(["/", "[/chat/a/a2]", "/playground/tokenizer", "/chat/b/b1"]);
    });

    it("corrects a landed URL that names no record by replacing that entry", () => {
        const history = start(
            new FakeHistory([
                { path: "/chat/gone/x", state: STATE },
                { path: "/chat/a/nope", state: STATE },
                { path: "/", state: STATE },
            ]),
        );
        history.go(-1);
        flushSync();
        expect(screen()).toBe("character=a chat=a1 playground=0 realm=false");
        history.go(-1);
        flushSync();
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
        expect(history.log).toEqual(["replace /", "replace /chat/a/a1", "replace /"]);
        expect(history.paths()).toEqual(["[/]", "/chat/a/a1", "/"]);
    });

    it("applies the router's own landing again without an extra step", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/chat/a/a1", state: STATE },
            ]),
        );
        const below = history.keyBelow();
        selectCharacter(null);
        flushSync();
        history.land(below);
        flushSync();
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1", `traverse ${below}`, "replace /"]);
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
    });
});

describe("a removed character", () => {
    it("replaces the selected character's entry with home, even when home is beneath", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/chat/b/b1", state: STATE },
            ]),
        );
        expect(removeCharacters(["b"])).toEqual(["b"]);
        flushSync();
        expect(screen()).toBe("character=null chat=null playground=0 realm=false");
        expect(history.log).toEqual(["replace /chat/b/b1", "replace /"]);
        expect(history.paths()).toEqual(["/", "[/]"]);
        restoreCharacters();
    });

    it("replaces the entry with the next selection when the removal came with one", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/chat/b/b1", state: STATE },
            ]),
        );
        // The membership hook runs inside the removal; a caller that selects another character in
        // the same handler settles on that character.
        removeCharacters(["b"]);
        selectCharacter("a");
        flushSync();
        expect(screen()).toBe("character=a chat=a1 playground=0 realm=false");
        expect(history.log).toEqual(["replace /chat/b/b1", "replace /chat/a"]);
        restoreCharacters();
    });

    it("takes no step when a character that is not shown is removed", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/chat/a/a1", state: STATE },
            ]),
        );
        removeCharacters(["b"]);
        flushSync();
        expect(screen()).toBe("character=a chat=a1 playground=0 realm=false");
        expect(history.log).toEqual(["replace /chat/a/a1"]);
        restoreCharacters();
    });
});

/** Puts every character back for the later tests. */
function restoreCharacters() {
    restorePlayground();
}

describe("boot (layers)", () => {
    it("opens a layer URL without state over home and waits for the root insertion", () => {
        let history = start(new FakeHistory([{ path: "/settings/model" }]));
        expect(screen()).toBe(HOME);
        expect(layers()).toBe("settings=true:1 grid=false");
        // The stamp, then the `rootPending` mark.
        expect(history.log).toEqual(["replace /settings/model", "replace /settings/model"]);
        expect(history.state).toEqual(layer(1, "/", { rootPending: true }));
        stop!();
        resetLayers();

        history = start(new FakeHistory([{ path: "/characters/" }]));
        expect(screen()).toBe(HOME);
        expect(layers()).toBe("settings=false:-1 grid=true");
        expect(history.log).toEqual(["replace /characters", "replace /characters"]);
        expect(history.state).toEqual(layer(1, "/", { rootPending: true }));
    });

    it("applies a stamped layer entry's base first, then the layer (a reload), without a root insertion", () => {
        const history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/settings/prompt", state: layer(1, "/chat/a/a2") },
            ]),
        );
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(layers()).toBe(`settings=true:${PROMPT} grid=false`);
        expect(history.log).toEqual(["replace /settings/prompt"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a2"));
        click();
        expect(history.paths()).toEqual(["/", "[/settings/prompt]"]);
    });

    it("replaces the old /settings/bot URL with /settings/memory and opens the Memory page", () => {
        const history = start(new FakeHistory([{ path: "/settings/bot", state: layer(1, "/chat/a/a1") }]));
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe(`settings=true:${SETTINGS_PAGES.memory} grid=false`);
        expect(history.log).toEqual(["replace /settings/memory"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
    });

    it("/settings is the model page on a wide screen and the list on a narrow one", () => {
        let history = start(new FakeHistory([{ path: "/settings", state: layer(1, "/") }]));
        expect(layers()).toBe("settings=true:1 grid=false");
        expect(history.log).toEqual(["replace /settings/model"]);
        stop!();
        resetLayers();

        window.innerWidth = NARROW;
        history = start(new FakeHistory([{ path: "/settings", state: layer(1, "/") }]));
        expect(layers()).toBe("settings=true:-1 grid=false");
        expect(history.log).toEqual(["replace /settings"]);
    });

    it("applies a layer entry stamped without a base (an older entry state) over home, without a root insertion", () => {
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings/model", state: STATE },
            ]),
        );
        expect(screen()).toBe(HOME);
        expect(layers()).toBe("settings=true:1 grid=false");
        expect(history.log).toEqual(["replace /settings/model"]);
        expect(history.state).toEqual(layer(1, "/"));
        click();
        expect(history.log).toHaveLength(1);
    });

    it("keeps a layer opened before the start (an import) over the URL's base, and waits for its base entry", () => {
        settingsOpen.set(true);
        SettingsMenuIndex.set(SETTINGS_PAGES.memory);
        flushSync();
        const history = start(new FakeHistory([{ path: "/chat/a/a1" }]));
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe(`settings=true:${SETTINGS_PAGES.memory} grid=false`);
        expect(history.log).toEqual(["replace /settings/memory", "replace /settings/memory"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1", { rootPending: true }));
        click();
        expect(history.paths()).toEqual(["/chat/a/a1", "[/settings/memory]"]);
        expect(history.entries[0].state).toEqual(STATE);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
    });
});

describe("popstate (layers)", () => {
    it("closes the layers on a base entry, and applies a layer entry's base under its layer", () => {
        const history = start(
            new FakeHistory(
                [
                    { path: "/chat/a/a1", state: STATE },
                    { path: "/settings/model", state: layer(1, "/chat/a/a1") },
                    { path: "/chat/b/b1", state: STATE },
                    { path: "/characters", state: layer(1, "/chat/b/b1") },
                ],
                { index: 1 },
            ),
        );
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe("settings=true:1 grid=false");
        history.go(-1);
        flushSync();
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe("settings=false:1 grid=false");
        history.go(2);
        flushSync();
        expect(screen()).toBe(CHAT_B);
        expect(layers()).toBe("settings=false:1 grid=false");
        history.go(1);
        flushSync();
        expect(screen()).toBe(CHAT_B);
        expect(layers()).toBe("settings=false:1 grid=true");
        // Back to the settings entry: its base (A) is applied under it, and the grid closes.
        history.go(-2);
        flushSync();
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe("settings=true:1 grid=false");
        expect(history.log).toEqual([
            "replace /settings/model",
            "replace /chat/a/a1",
            "replace /chat/b/b1",
            "replace /characters",
            "replace /settings/model",
        ]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
    });

    it("applies a layer URL without state (a fragment change) over the stores' base, without a root insertion", () => {
        const history = start(
            new FakeHistory([{ path: "/chat/a/a1", state: STATE }, { path: "/characters" }], { index: 0 }),
        );
        history.go(1);
        flushSync();
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe("settings=false:-1 grid=true");
        expect(history.log).toEqual(["replace /chat/a/a1", "replace /characters"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
        click();
        expect(history.log).toHaveLength(2);
    });

    it("lands a layer entry whose base names a removed character at home, marked rebased", () => {
        const history = start(
            new FakeHistory(
                [
                    { path: "/chat/b/b1", state: STATE },
                    { path: "/settings/model", state: layer(1, "/chat/b/b1") },
                    { path: "/", state: STATE },
                ],
                { index: 2 },
            ),
        );
        removeCharacters(["b"]);
        history.go(-1);
        flushSync();
        expect(screen()).toBe(HOME);
        expect(layers()).toBe("settings=true:1 grid=false");
        expect(history.state).toEqual(layer(1, "/", { rebased: true }));
        restoreCharacters();
    });
});

describe("the sync effect (layers)", () => {
    it("opens a layer with a push over the base entry and closes it with a back to that entry", () => {
        const history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }]));
        // The settings button: index -1 on a wide screen is the model page, set without a step.
        settingsOpen.set(true);
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(MODEL);
        expect(history.log).toEqual(["replace /chat/a/a1", "push /settings/model"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
        const below = history.keyBelow();
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(2)).toEqual([`traverse ${below}`]);
        history.land(below);
        flushSync();
        expect(history.log.slice(3)).toEqual(["replace /chat/a/a1"]);
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe("settings=false:1 grid=false");

        gridOpenStore.set(true);
        flushSync();
        expect(history.log.slice(4)).toEqual(["push /characters"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
        gridOpenStore.set(false);
        flushSync();
        expect(history.log.slice(5)).toEqual([`traverse ${history.keyBelow()}`]);
    });

    it("replaces the close when the entry beneath is not the base, and without the Navigation API", () => {
        let history = start(
            new FakeHistory([
                { path: "/", state: STATE },
                { path: "/settings/model", state: layer(1, "/chat/a/a1") },
            ]),
        );
        settingsOpen.set(false);
        flushSync();
        expect(history.log).toEqual(["replace /settings/model", "replace /chat/a/a1"]);
        expect(history.state).toEqual(STATE);
        expect(history.paths()).toEqual(["/", "[/chat/a/a1]"]);
        stop!();
        resetLayers();

        history = start(
            new FakeHistory(
                [
                    { path: "/chat/a/a1", state: STATE },
                    { path: "/characters", state: layer(1, "/chat/a/a1") },
                ],
                { navigation: false },
            ),
        );
        gridOpenStore.set(false);
        flushSync();
        expect(history.log).toEqual(["replace /characters", "replace /chat/a/a1"]);
        expect(history.paths()).toEqual(["/chat/a/a1", "[/chat/a/a1]"]);
    });

    it("replaces a page switch on a wide screen, pushes the prompt template, and goes back from it", () => {
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings/model", state: layer(1, "/chat/a/a1") },
            ]),
        );
        SettingsMenuIndex.set(PROMPT);
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /settings/prompt"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
        SettingsMenuIndex.set(TEMPLATE);
        flushSync();
        expect(history.log.slice(2)).toEqual(["push /settings/prompt-template"]);
        expect(history.state).toEqual(layer(2, "/chat/a/a1"));
        const prompt = history.keyBelow();
        // The template's back button.
        SettingsMenuIndex.set(PROMPT);
        flushSync();
        expect(history.log.slice(3)).toEqual([`traverse ${prompt}`]);
        history.land(prompt);
        flushSync();
        expect(history.log.slice(4)).toEqual(["replace /settings/prompt"]);
        expect(layers()).toBe(`settings=true:${PROMPT} grid=false`);
        // From the template to another page: a replace at depth 2, so the close goes two below.
        SettingsMenuIndex.set(TEMPLATE);
        flushSync();
        SettingsMenuIndex.set(MODEL);
        flushSync();
        expect(history.log.slice(5)).toEqual(["push /settings/prompt-template", "replace /settings/model"]);
        expect(history.state).toEqual(layer(2, "/chat/a/a1"));
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(7)).toEqual([`traverse ${history.keyBelow(2)}`]);
        expect(history.entries[0].path).toBe("/chat/a/a1");
    });

    it("on a narrow screen: pushes the list → a page, goes back page → list, and closes from a page by two", () => {
        window.innerWidth = NARROW;
        const history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }]));
        settingsOpen.set(true);
        flushSync();
        expect(layers()).toBe("settings=true:-1 grid=false");
        expect(history.log.slice(1)).toEqual(["push /settings"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
        SettingsMenuIndex.set(DISPLAY);
        flushSync();
        expect(history.log.slice(2)).toEqual(["push /settings/display"]);
        expect(history.state).toEqual(layer(2, "/chat/a/a1"));
        // The page's close button sets the index to -1: back to the list.
        const list = history.keyBelow();
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(history.log.slice(3)).toEqual([`traverse ${list}`]);
        history.land(list);
        flushSync();
        expect(history.log.slice(4)).toEqual(["replace /settings"]);
        expect(layers()).toBe("settings=true:-1 grid=false");
        // The list's close button on a page (Escape too): the base is two below.
        SettingsMenuIndex.set(DISPLAY);
        flushSync();
        expect(history.log.slice(5)).toEqual(["push /settings/display"]);
        const base = history.keyBelow(2);
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(6)).toEqual([`traverse ${base}`]);
        history.land(base);
        flushSync();
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe(`settings=false:${DISPLAY} grid=false`);
        expect(history.paths()).toEqual(["[/chat/a/a1]", "/settings", "/settings/display"]);
    });

    it("on a narrow screen: a remembered page opened from a base entry gets the list beneath it", () => {
        window.innerWidth = NARROW;
        SettingsMenuIndex.set(DISPLAY);
        flushSync();
        const history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }]));
        settingsOpen.set(true);
        flushSync();
        expect(history.log.slice(1)).toEqual(["push /settings", "push /settings/display"]);
        expect(history.paths()).toEqual(["/chat/a/a1", "/settings", "[/settings/display]"]);
        expect(history.entries[1].state).toEqual(layer(1, "/chat/a/a1"));
        expect(history.state).toEqual(layer(2, "/chat/a/a1"));
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(history.log.slice(3)).toEqual([`traverse ${history.keyBelow()}`]);
    });

    it("on a narrow screen without the Navigation API: page → list replaces, and the close replaces", () => {
        window.innerWidth = NARROW;
        const history = start(
            new FakeHistory(
                [
                    { path: "/chat/a/a1", state: STATE },
                    { path: "/settings", state: layer(1, "/chat/a/a1") },
                    { path: "/settings/display", state: layer(2, "/chat/a/a1") },
                ],
                { navigation: false },
            ),
        );
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /settings"]);
        expect(history.state).toEqual(layer(2, "/chat/a/a1"));
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(2)).toEqual(["replace /chat/a/a1"]);
        expect(history.paths()).toEqual(["/chat/a/a1", "/settings", "[/chat/a/a1]"]);
    });

    it("a character picked in the grid rebases the entry, and the close replaces with the new base", () => {
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/characters", state: layer(1, "/chat/a/a1") },
            ]),
        );
        selectCharacter("b");
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /characters"]);
        expect(history.state).toEqual(layer(1, "/chat/b", { rebased: true }));
        // A change that keeps the base takes no step.
        chat.selectChat("a", "a2");
        flushSync();
        expect(history.log).toHaveLength(2);
        gridOpenStore.set(false);
        flushSync();
        expect(history.log.slice(2)).toEqual(["replace /chat/b"]);
        expect(history.state).toEqual(STATE);
        expect(history.paths()).toEqual(["/chat/a/a1", "[/chat/b]"]);
        expect(screen()).toBe(CHAT_B);
    });

    it("a close with a base change in the same step replaces; the old base picked again goes back", () => {
        let history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings/model", state: layer(1, "/chat/a/a1") },
            ]),
        );
        // The Home hotkey, then Escape, in one settled step.
        selectCharacter(null);
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /"]);
        expect(screen()).toBe(HOME);
        stop!();
        resetLayers();

        history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/characters", state: layer(1, "/chat/a/a1") },
            ]),
        );
        selectCharacter("b");
        flushSync();
        // A picked again with its chat open: the base beneath again.
        selectCharacter("a");
        setChatOpen(true);
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /characters", "replace /characters"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1", { rebased: true }));
        gridOpenStore.set(false);
        flushSync();
        expect(history.log.slice(3)).toEqual([`traverse ${history.keyBelow()}`]);
    });

    it("a base change in the same step as a move inside the layer replaces, and a rebased entry never goes back", () => {
        window.innerWidth = NARROW;
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings", state: layer(1, "/chat/a/a1") },
                { path: "/settings/display", state: layer(2, "/chat/a/a1") },
            ]),
        );
        // One settled step: B selected and the page closed to the list.
        selectCharacter("b");
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /settings"]);
        expect(history.state).toEqual(layer(2, "/chat/b", { rebased: true }));
        // The list → a page still pushes; the page → the list replaces (the list beneath names A).
        SettingsMenuIndex.set(DISPLAY);
        flushSync();
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(history.log.slice(2)).toEqual(["push /settings/display", "replace /settings"]);
        expect(history.state).toEqual(layer(3, "/chat/b", { rebased: true }));
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(4)).toEqual(["replace /chat/b"]);
        expect(history.paths()).toEqual(["/chat/a/a1", "/settings", "/settings", "[/chat/b]"]);
    });

    it("switching between settings and the grid replaces at the same depth, before any back", () => {
        window.innerWidth = NARROW;
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings", state: layer(1, "/chat/a/a1") },
                { path: "/settings/display", state: layer(2, "/chat/a/a1") },
            ]),
        );
        gridOpenStore.set(true);
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /characters"]);
        expect(history.state).toEqual(layer(2, "/chat/a/a1"));
        // Settings again, on the list: the list entry beneath is not taken; the grid entry is.
        settingsOpen.set(true);
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(layers()).toBe("settings=true:-1 grid=false");
        expect(history.log.slice(2)).toEqual(["replace /settings"]);
        expect(history.state).toEqual(layer(2, "/chat/a/a1"));
        expect(history.paths()).toEqual(["/chat/a/a1", "/settings", "[/settings]"]);
    });

    it("one layer at a time: settings opened over the grid closes it, so the close shows the base", () => {
        const history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }]));
        gridOpenStore.set(true);
        flushSync();
        settingsOpen.set(true);
        flushSync();
        expect(layers()).toBe("settings=true:1 grid=false");
        expect(history.log.slice(1)).toEqual(["push /characters", "replace /settings/model"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(3)).toEqual([`traverse ${history.keyBelow()}`]);
        expect(layers()).toBe("settings=false:1 grid=false");
    });

    it("normalizes the list to the model page on a wide screen without a step, and takes one back for it", () => {
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings/model", state: layer(1, "/chat/a/a1") },
            ]),
        );
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(MODEL);
        expect(history.log).toEqual(["replace /settings/model"]);
        // A model entry beneath the template: prompt → template, back, model, forward, then the list.
        SettingsMenuIndex.set(PROMPT);
        flushSync();
        SettingsMenuIndex.set(TEMPLATE);
        flushSync();
        history.go(-1);
        flushSync();
        SettingsMenuIndex.set(MODEL);
        flushSync();
        history.go(1);
        flushSync();
        expect(history.log.slice(1)).toEqual([
            "replace /settings/prompt",
            "push /settings/prompt-template",
            "replace /settings/prompt",
            "replace /settings/model",
            "replace /settings/prompt-template",
        ]);
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(get(SettingsMenuIndex)).toBe(MODEL);
        // The normalizing write keeps the route: exactly one step, and no retry. The template was
        // reached by a forward landing, which marks it `rebased`, so the step is a replace, not a back.
        expect(history.log.slice(6)).toEqual(["replace /settings/model"]);
        flushSync();
        flushSync();
        expect(history.log).toHaveLength(7);
    });

    it("a chat switch under a layer and a base change back to the entry's base take no extra step", () => {
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings/model", state: layer(1, "/chat/a/a1") },
            ]),
        );
        chat.selectChat("a", "a2");
        flushSync();
        expect(history.log.slice(1)).toEqual(["replace /settings/model"]);
        expect(history.state).toEqual(layer(1, "/chat/a/a2", { rebased: true }));
        chat.selectChat("a", "a2");
        flushSync();
        expect(history.log).toHaveLength(2);
    });

    it("stops following the layer stores after the stop", () => {
        const history = start(new FakeHistory([{ path: "/chat/a/a1", state: STATE }]));
        stop!();
        stop = null;
        settingsOpen.set(true);
        flushSync();
        expect(history.log).toEqual(["replace /chat/a/a1"]);
    });
});

describe("the root insertion", () => {
    it("inserts the base entry under a direct layer link at the first activation, before the app's handlers", () => {
        const history = start(new FakeHistory([{ path: "/settings/model" }]));
        // Not an activation: an untrusted click, Escape, a touch pointerdown, a mouse pointerup.
        window.dispatchEvent(new MouseEvent("click"));
        window.dispatchEvent(trusted(new KeyboardEvent("keydown", { key: "Escape" })));
        window.dispatchEvent(trusted(new PointerEvent("pointerdown", { pointerType: "touch" })));
        window.dispatchEvent(trusted(new PointerEvent("pointerup", { pointerType: "mouse" })));
        expect(history.paths()).toEqual(["[/settings/model]"]);
        expect(history.state).toEqual(layer(1, "/", { rootPending: true }));
        // A key the app handles: the window's capture listener runs before the document's handler.
        const seen: string[][] = [];
        const handler = () => seen.push(history.paths());
        document.addEventListener("keydown", handler);
        try {
            document.body.dispatchEvent(trusted(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
        } finally {
            document.removeEventListener("keydown", handler);
        }
        expect(seen).toEqual([["/", "[/settings/model]"]]);
        expect(history.entries[0].state).toEqual(STATE);
        expect(history.state).toEqual(layer(1, "/"));
        expect(history.log).toEqual([
            "replace /settings/model",
            "replace /settings/model",
            "replace /",
            "push /settings/model",
        ]);
        // Done: a later activation inserts nothing more, and the close goes back to the base entry.
        click();
        expect(history.log).toHaveLength(4);
        const root = history.keyBelow();
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(4)).toEqual([`traverse ${root}`]);
        history.land(root);
        flushSync();
        expect(screen()).toBe(HOME);
        expect(layers()).toBe("settings=false:1 grid=false");
    });

    it("accepts a mouse pointerdown, a touch pointerup, a touchend, and a mousedown", () => {
        const events = [
            trusted(new PointerEvent("pointerdown", { pointerType: "mouse" })),
            trusted(new PointerEvent("pointerup", { pointerType: "touch" })),
            trusted(new Event("touchend")),
            trusted(new MouseEvent("mousedown")),
        ];
        for (const event of events) {
            const history = start(new FakeHistory([{ path: "/characters" }]));
            window.dispatchEvent(event);
            expect(history.paths(), event.type).toEqual(["/", "[/characters]"]);
            stop!();
            resetLayers();
        }
    });

    it("inserts the list under a settings page on a narrow screen", () => {
        window.innerWidth = NARROW;
        const history = start(new FakeHistory([{ path: "/settings/display" }]));
        expect(layers()).toBe(`settings=true:${DISPLAY} grid=false`);
        click();
        expect(history.paths()).toEqual(["/", "/settings", "[/settings/display]"]);
        expect(history.entries.map((entry) => entry.state)).toEqual([STATE, layer(1, "/"), layer(2, "/")]);
        SettingsMenuIndex.set(-1);
        flushSync();
        expect(history.log.slice(5)).toEqual([`traverse ${history.keyBelow()}`]);
    });

    it("inserts the base the layer has now, not the one at boot (the base changed before the activation)", () => {
        const history = start(new FakeHistory([{ path: "/characters" }]));
        // A plugin or the import selects a character before any activation.
        selectCharacter("a");
        flushSync();
        expect(history.state).toEqual(layer(1, "/chat/a", { rebased: true, rootPending: true }));
        click();
        expect(history.paths()).toEqual(["/chat/a", "[/characters]"]);
        expect(history.state).toEqual(layer(1, "/chat/a"));
    });

    it("follows navigator.userActivation where it exists", () => {
        const activation = { isActive: false };
        Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
        try {
            const history = start(new FakeHistory([{ path: "/settings/model" }]));
            window.dispatchEvent(trusted(new MouseEvent("mousedown")));
            expect(history.paths()).toEqual(["[/settings/model]"]);
            activation.isActive = true;
            window.dispatchEvent(trusted(new MouseEvent("mousedown")));
            expect(history.paths()).toEqual(["/", "[/settings/model]"]);
        } finally {
            delete (navigator as { userActivation?: unknown }).userActivation;
        }
    });

    it("closes before any activation by a replace, and inserts nothing after", () => {
        const history = start(new FakeHistory([{ path: "/settings/model" }]));
        settingsOpen.set(false);
        flushSync();
        expect(history.log.slice(2)).toEqual(["replace /"]);
        expect(history.state).toEqual(STATE);
        click();
        expect(history.paths()).toEqual(["[/]"]);
        // Reopened by a click: an ordinary push over the base entry.
        settingsOpen.set(true);
        flushSync();
        expect(history.log.slice(3)).toEqual(["push /settings/model"]);
        expect(history.state).toEqual(layer(1, "/"));
    });

    it("keeps waiting across a switch of layers, and stops at a push without an activation", () => {
        window.innerWidth = NARROW;
        let history = start(new FakeHistory([{ path: "/characters" }]));
        settingsOpen.set(true);
        flushSync();
        expect(history.log.slice(2)).toEqual(["replace /settings"]);
        expect(history.state).toEqual(layer(1, "/", { rootPending: true }));
        click();
        expect(history.paths()).toEqual(["/", "[/settings]"]);
        stop!();
        resetLayers();

        history = start(new FakeHistory([{ path: "/settings" }]));
        // A page opened without an activation (a plugin): the entry above is not waiting.
        SettingsMenuIndex.set(DISPLAY);
        flushSync();
        expect(history.log.slice(2)).toEqual(["push /settings/display"]);
        expect(history.state).toEqual(layer(2, "/"));
        click();
        expect(history.paths()).toEqual(["/settings", "[/settings/display]"]);
    });

    it("waits again after a reload of an entry still pending, and stops at a popstate and at the stop", () => {
        let history = start(
            new FakeHistory([{ path: "/characters", state: layer(1, "/chat/a/a1", { rootPending: true }) }]),
        );
        expect(screen()).toBe(CHAT_A);
        expect(layers()).toBe("settings=false:-1 grid=true");
        expect(history.log).toEqual(["replace /characters", "replace /characters"]);
        click();
        expect(history.paths()).toEqual(["/chat/a/a1", "[/characters]"]);
        expect(history.entries[0].state).toEqual(STATE);
        expect(history.state).toEqual(layer(1, "/chat/a/a1"));
        stop!();
        resetLayers();

        // A fragment change on the pending entry: the wait ends, the mark stays for the next reload.
        history = start(new FakeHistory([{ path: "/settings/model" }]));
        history.go(0);
        flushSync();
        expect(history.state).toEqual(layer(1, "/", { rootPending: true }));
        click();
        expect(history.paths()).toEqual(["[/settings/model]"]);
        stop!();
        resetLayers();

        history = start(new FakeHistory([{ path: "/settings/model" }]));
        stop!();
        stop = null;
        click();
        expect(history.paths()).toEqual(["[/settings/model]"]);
        expect(history.log).toHaveLength(2);
    });
});

describe("openRoute (a notification's chat)", () => {
    it("applies a chat route to the stores and the effect pushes its URL", () => {
        const history = start(new FakeHistory([{ path: "/" }]));
        expect(openRoute("/chat/b/b1")).toBe(true);
        flushSync();
        expect(screen()).toBe(CHAT_B);
        expect(history.path).toBe("/chat/b/b1");
        expect(history.log).toEqual(["replace /", "push /chat/b/b1"]);
    });

    it("closes an open layer before showing the chat", () => {
        start(new FakeHistory([{ path: "/" }]));
        gridOpenStore.set(true);
        flushSync();
        expect(get(gridOpenStore)).toBe(true);
        expect(openRoute("/chat/a/a2")).toBe(true);
        flushSync();
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(get(gridOpenStore)).toBe(false);
        expect(get(settingsOpen)).toBe(false);
    });

    it("ignores a layer route, an unknown path, and a call before the router started", () => {
        const history = start(new FakeHistory([{ path: "/" }]));
        expect(openRoute("/settings")).toBe(false);
        expect(openRoute("/nope/x")).toBe(false);
        expect(openRoute("https://evil.test/chat/a/a1")).toBe(false);
        flushSync();
        expect(screen()).toBe(HOME);
        expect(get(settingsOpen)).toBe(false);
        expect(history.paths()).toEqual(["[/]"]);
        stop!();
        stop = null;
        expect(openRoute("/chat/a/a1")).toBe(false);
        expect(screen()).toBe(HOME);
    });
});

describe("layer edge cases: rebased entries and removed characters", () => {
    // The list beneath was rebased while this page was a forward entry; its state cannot be read,
    // so a page reached by a landing is marked `rebased` and its close replaces instead of going
    // back to the list (whose landing would apply home and lose A).
    it("a move inside the layer does not go back from an entry reached by a landing above depth 1", () => {
        window.innerWidth = NARROW;
        const history = start(
            new FakeHistory([
                { path: "/chat/a/a1", state: STATE },
                { path: "/settings", state: layer(1, "/chat/a/a1") },
                { path: "/settings/display", state: layer(2, "/chat/a/a1") },
            ]),
        );
        history.go(-1);
        flushSync();
        // The Home hotkey on the list rebases the list entry.
        selectCharacter(null);
        flushSync();
        expect(history.entries[1].state).toEqual(layer(1, "/", { rebased: true }));
        history.go(1);
        flushSync();
        expect(screen()).toBe(CHAT_A);
        // The page's close button: a replace, not a back to the list (k2).
        SettingsMenuIndex.set(-1);
        flushSync();
        const step = history.log.at(-1)!;
        if (step.startsWith("traverse ")) {
            history.land(step.slice("traverse ".length));
            flushSync();
        }
        expect(screen()).toBe(CHAT_A);
        expect(history.log.slice(4)).toEqual(["replace /settings"]);
    });

    // Under a layer, a removed selected character goes home as it does without a layer: the
    // stale playground value is cleared, not kept as the layer's base.
    it("a removed character under a layer goes home, not to the stale playground menu", () => {
        const history = start(new FakeHistory([{ path: "/playground", state: STATE }]));
        // The sidebar from the playground menu: `changeChar` leaves the playground value at 1.
        selectCharacter("a");
        flushSync();
        settingsOpen.set(true);
        flushSync();
        expect(history.paths()).toEqual(["/playground", "/chat/a", "[/settings/model]"]);
        removeCharacters(["a"]);
        flushSync();
        const observed = { screen: screen(), state: history.state };
        restoreCharacters();
        expect(observed.screen).toBe(HOME);
        expect(observed.state).toEqual(layer(1, "/", { rebased: true }));
    });
});

describe("browserHistory", () => {
    const entry = (
        index: number,
        url: string | null,
        options: { key?: string; sameDocument?: boolean } = {},
    ): NavigationHistoryEntry =>
        ({
            index,
            url,
            key: options.key ?? `key${index}`,
            sameDocument: options.sameDocument ?? true,
        }) as unknown as NavigationHistoryEntry;

    function navigation(entries: NavigationHistoryEntry[], current: number) {
        const traversals: string[] = [];
        const api: NavigationLike & { traversals: string[] } = {
            traversals,
            get currentEntry() {
                return entries[current] ?? null;
            },
            entries: () => entries,
            traverseTo(key) {
                traversals.push(key);
                return {
                    committed: Promise.reject(new Error("aborted")),
                    finished: Promise.reject(new Error("aborted")),
                };
            },
        };
        return api;
    }

    it("reads the path and state live, and writes through pushState and replaceState", () => {
        const port = browserHistory(null);
        port.replace("/chat/a/a1", STATE);
        expect(port.path).toBe("/chat/a/a1");
        expect(port.state).toEqual(STATE);
        port.push("/realm", STATE);
        expect(port.path).toBe("/realm");
        // Another writer: the getters are live, not copies.
        history.replaceState({ other: true }, "", "/playground?x=1#y");
        expect(port.path).toBe("/playground");
        expect(port.state).toEqual({ other: true });
        history.replaceState(null, "", "/");
    });

    it("never finds an entry beneath without the Navigation API, and never traverses", () => {
        const port = browserHistory(null);
        expect(port.entryBelow(1)).toBeNull();
        expect(() => port.traverse("key0")).not.toThrow();
    });

    it("finds the entry beneath only when it is a same-document entry with a readable URL", () => {
        const origin = "https://app.test";
        const entries = [
            entry(0, `${origin}/`),
            entry(1, `${origin}/chat/a/a1?q=1#h`),
            entry(2, `${origin}/realm`, { sameDocument: false }),
            entry(3, null),
            entry(4, "not a url"),
            entry(5, `${origin}/playground`, { key: "" }),
            entry(6, `${origin}/playground/tokenizer`),
        ];
        expect(browserHistory(navigation(entries, 1)).entryBelow(1)).toEqual({ key: "key0", path: "/" });
        expect(browserHistory(navigation(entries, 2)).entryBelow(1)).toEqual({ key: "key1", path: "/chat/a/a1" });
        expect(browserHistory(navigation(entries, 3)).entryBelow(1)).toBeNull();
        expect(browserHistory(navigation(entries, 4)).entryBelow(1)).toBeNull();
        expect(browserHistory(navigation(entries, 5)).entryBelow(1)).toBeNull();
        expect(browserHistory(navigation(entries, 6)).entryBelow(1)).toBeNull();
        expect(browserHistory(navigation(entries, 6)).entryBelow(5)).toEqual({ key: "key1", path: "/chat/a/a1" });
        // Below the first entry, and no current entry.
        expect(browserHistory(navigation(entries, 0)).entryBelow(1)).toBeNull();
        expect(browserHistory(navigation(entries, 1)).entryBelow(2)).toBeNull();
        expect(browserHistory(navigation(entries, 9)).entryBelow(1)).toBeNull();
    });

    it("traverses by key and swallows the rejections and a synchronous failure", async () => {
        const api = navigation([entry(0, "https://app.test/"), entry(1, "https://app.test/realm")], 1);
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            const port = browserHistory(api);
            port.traverse("key0");
            expect(api.traversals).toEqual(["key0"]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(unhandled).not.toHaveBeenCalled();
            api.traverseTo = () => {
                throw new DOMException("no entry", "InvalidStateError");
            };
            expect(() => port.traverse("key0")).not.toThrow();
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });

    it("subscribes to popstate until the removal", () => {
        const port = browserHistory(null);
        const listener = vi.fn();
        const remove = port.onPopState(listener);
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(listener).toHaveBeenCalledTimes(1);
        remove();
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
