import { flushSync } from "svelte";
import { get } from "svelte/store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";

// The router for the base routes (`docs/plan/url-routes.md`, slice 3, decision 8) against a fake
// `HistoryPort`: boot with and without state, every `popstate` applied, the sync effect's R1 steps
// (push, the chat-switch replace, a back only to the confirmed entry beneath and never without the
// Navigation API), the R4 corrections, G2 (a back that does nothing is not retried) and G4 (the URL
// catches up at the next change), the playground value 2 normalization through the real effect rerun,
// and stop/restart. The module graph is imported once (a reset graph would get its own Svelte
// runtime, and the effect would not see the stores), so each test starts the router on a fresh fake
// and stops it after. The browser adapter is checked at the end against happy-dom's history and a
// fake Navigation API.

vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
}));

import { OpenRealmStore, PlaygroundStore } from "../stores.svelte";
import { characterList, removeCharacters } from "../storage/characterStore.svelte";
import * as chat from "../storage/chatStore.svelte";
import { initializeRecords, takeRecordFields } from "../storage/records.svelte";
import { selectCharacter, selection } from "../storage/selection.svelte";
import { browserHistory, type HistoryPort, type NavigationLike, type RouteState, startRouter } from "./router.svelte";

const PLAYGROUND = "§playground";
const STATE: RouteState = { v: 1, layerDepth: 0 };

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
    // The stores at home, the first chat selected for every character.
    selectCharacter(null);
    PlaygroundStore.set(0);
    OpenRealmStore.set(false);
    chat.selectChat("a", "a1");
    chat.selectChat("b", "b1");
    chat.selectChat(PLAYGROUND, "p1");
    flushSync();
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

    it("R4: completes /chat/:chaId with the selected chat, and falls back from an unknown chat id", () => {
        chat.selectChat("a", "a2");
        let history = start(new FakeHistory([{ path: "/chat/a" }]));
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(history.log).toEqual(["replace /chat/a/a2"]);
        stop!();

        history = start(new FakeHistory([{ path: "/chat/a/missing", state: STATE }]));
        expect(screen()).toBe("character=a chat=a2 playground=0 realm=false");
        expect(history.log).toEqual(["replace /chat/a/a2"]);
    });

    it("R4: an unknown character, an unknown path, and (until slice 4) a layer URL go home", () => {
        for (const path of ["/chat/nobody/x", "/nonsense", "/settings/model", "/characters", "/playground/chat/p1"]) {
            if (path === "/playground/chat/p1") {
                // The playground character is checked like any other.
                removeCharacters([PLAYGROUND]);
            }
            const history = start(new FakeHistory([{ path, state: STATE }]));
            expect(screen(), path).toBe("character=null chat=null playground=0 realm=false");
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
        expect(first.log).toEqual(["replace /", "push /chat/a/a1"]);

        stop!();
        stop = null;
        // Stopped: neither a store change nor a popstate reaches the history.
        selectCharacter("b");
        flushSync();
        first.go(-1);
        expect(first.log).toEqual(["replace /", "push /chat/a/a1"]);
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

describe("the sync effect (R1)", () => {
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
            "push /chat/a/a1",
            "push /chat/b/b1",
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
        expect(history.log).toEqual(["replace /chat/a/a1", "push /chat/b/b1"]);
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

    it("never goes back without the Navigation API (A4)", () => {
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

    it("G2: a back that does nothing is not retried; G4: the URL catches up at the next change", () => {
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
        expect(history.log.slice(2)).toEqual(["push /chat/b/b1"]);
        expect(history.paths()).toEqual(["/", "/chat/a/a1", "[/chat/b/b1]"]);
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
        // The back does nothing: no retry (G2).
        flushSync();
        expect(history.log).toHaveLength(2);
        // The next change catches up from the stale URL (G4): the menu entry was never reached.
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

    it("corrects a landed URL that names no record (R4) by replacing that entry", () => {
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

    it("applies the router's own landing again (A6) without an extra step", () => {
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

describe("R4: a removed character", () => {
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
        expect(history.log).toEqual(["replace /chat/b/b1", "replace /chat/a/a1"]);
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
