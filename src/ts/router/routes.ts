import {
    API_KEYS_SETTINGS_MENU,
    MODEL_PROFILES_SETTINGS_MENU,
    MODEL_SETTINGS_MENU,
    PROMPT_SETTINGS_MENU,
} from "../settingsMenu";

/*
 * The client's route table (`docs/plan/url-routes.md`): the paths of the screens, and the slugs of
 * the settings pages (`SettingsMenuIndex`) and playground tools (`PlaygroundStore`). These tables
 * are the only place that maps the magic numbers to names. The first segments are
 * `CLIENT_ROUTE_SEGMENTS` (`shared/routes.ts`), which the server serves the client for.
 */

/** The settings page slugs (`/settings/:page`) and their `SettingsMenuIndex`. */
export const SETTINGS_PAGES = {
    model: MODEL_SETTINGS_MENU,
    connections: MODEL_PROFILES_SETTINGS_MENU,
    "api-keys": API_KEYS_SETTINGS_MENU,
    prompt: PROMPT_SETTINGS_MENU,
    "prompt-template": 13,
    persona: 12,
    bot: 2,
    display: 3,
    language: 10,
    accessibility: 11,
    modules: 14,
    plugins: 4,
    user: 0,
    hotkeys: 15,
    advanced: 6,
    thanks: 77,
} as const satisfies Record<string, number>;

/** The playground tool slugs (`/playground/:tool`) and their `PlaygroundStore` value. The menu is 1, the chat 2. */
export const PLAYGROUND_TOOLS = {
    embedding: 3,
    tokenizer: 4,
    syntax: 5,
    jinja: 6,
    "image-gen": 7,
    parser: 8,
    subtitle: 9,
    "image-translate": 10,
    translation: 11,
    mcp: 12,
    docs: 13,
    inlays: 14,
    "tool-conversion": 101,
} as const satisfies Record<string, number>;

export type SettingsPage = keyof typeof SETTINGS_PAGES;
export type PlaygroundTool = keyof typeof PLAYGROUND_TOOLS;

export type Route =
    | { kind: "home" }
    | { kind: "realm" }
    /** `chatId` is null for `/chat/:chaId`, which names no chat yet. */
    | { kind: "chat"; chaId: string; chatId: string | null }
    | { kind: "playground" }
    | { kind: "playgroundTool"; tool: PlaygroundTool }
    /** The playground chat (the `§playground` character); `chatId` is null for `/playground/chat`. */
    | { kind: "playgroundChat"; chatId: string | null }
    | { kind: "characters" }
    /** `page` is null for the settings list (`/settings`, `SettingsMenuIndex` -1). */
    | { kind: "settings"; page: SettingsPage | null };

function hasKey<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
    return Object.hasOwn(table, key);
}

/** The settings page slug of a `SettingsMenuIndex`; null for an index with no route. */
export function settingsPageOf(index: number): SettingsPage | null {
    return (Object.keys(SETTINGS_PAGES) as SettingsPage[]).find((slug) => SETTINGS_PAGES[slug] === index) ?? null;
}

/** The playground tool slug of a `PlaygroundStore` value; null for the menu, the chat, or a value with no route. */
export function playgroundToolOf(value: number): PlaygroundTool | null {
    return (Object.keys(PLAYGROUND_TOOLS) as PlaygroundTool[]).find((slug) => PLAYGROUND_TOOLS[slug] === value) ?? null;
}

/** The canonical path of a route. */
export function formatRoute(route: Route): string {
    switch (route.kind) {
        case "home":
            return "/";
        case "realm":
            return "/realm";
        case "chat":
            return route.chatId === null
                ? `/chat/${encodeURIComponent(route.chaId)}`
                : `/chat/${encodeURIComponent(route.chaId)}/${encodeURIComponent(route.chatId)}`;
        case "playground":
            return "/playground";
        case "playgroundTool":
            return `/playground/${route.tool}`;
        case "playgroundChat":
            return route.chatId === null ? "/playground/chat" : `/playground/chat/${encodeURIComponent(route.chatId)}`;
        case "characters":
            return "/characters";
        case "settings":
            return route.page === null ? "/settings" : `/settings/${route.page}`;
    }
}

/**
 * The route of a URL pathname (without the query or hash); null when it names no route. Trailing
 * slashes are ignored; an empty segment, an undecodable or empty id, and an unknown slug are not a
 * route. Whether an id names a record is the router's check, not this one.
 */
export function parseRoute(path: string): Route | null {
    const trimmed = path.replace(/\/+$/, "");
    if (trimmed === "") {
        return path.startsWith("/") ? { kind: "home" } : null;
    }
    if (!trimmed.startsWith("/")) {
        return null;
    }
    let segments: string[];
    try {
        segments = trimmed.slice(1).split("/").map(decodeURIComponent);
    } catch {
        return null;
    }
    if (segments.some((segment) => segment === "")) {
        return null;
    }
    const [first, second, third, ...rest] = segments;
    switch (first) {
        case "realm":
            return segments.length === 1 ? { kind: "realm" } : null;
        case "characters":
            return segments.length === 1 ? { kind: "characters" } : null;
        case "chat":
            if (second === undefined || rest.length > 0) {
                return null;
            }
            return { kind: "chat", chaId: second, chatId: third ?? null };
        case "playground":
            if (second === undefined) {
                return { kind: "playground" };
            }
            if (second === "chat") {
                return rest.length === 0 ? { kind: "playgroundChat", chatId: third ?? null } : null;
            }
            return third === undefined && hasKey(PLAYGROUND_TOOLS, second)
                ? { kind: "playgroundTool", tool: second }
                : null;
        case "settings":
            if (second === undefined) {
                return { kind: "settings", page: null };
            }
            return third === undefined && hasKey(SETTINGS_PAGES, second) ? { kind: "settings", page: second } : null;
        default:
            return null;
    }
}
