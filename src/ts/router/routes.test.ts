import { describe, expect, it } from "vitest";
import { CLIENT_ROUTE_SEGMENTS, isClientRoutePath } from "../../../shared/routes.ts";
import {
    IMAGE_GENERATION_SETTINGS_MENU,
    MEMORY_SETTINGS_MENU,
    TRANSLATION_SETTINGS_MENU,
    VOICE_SETTINGS_MENU,
} from "../settingsMenu";
import {
    formatRoute,
    parseRoute,
    PLAYGROUND_TOOLS,
    playgroundToolOf,
    type PlaygroundTool,
    type Route,
    SETTINGS_PAGES,
    settingsPageOf,
    type SettingsPage,
} from "./routes";

const settingsPages = Object.keys(SETTINGS_PAGES) as SettingsPage[];
const playgroundTools = Object.keys(PLAYGROUND_TOOLS) as PlaygroundTool[];

const routes: Route[] = [
    { kind: "home" },
    { kind: "realm" },
    { kind: "chat", chaId: "c1", chatId: null },
    { kind: "chat", chaId: "c1", chatId: "chat-1" },
    { kind: "chat", chaId: "a/b %?#", chatId: "x/y%2F" },
    { kind: "chat", chaId: "§playground", chatId: "한글 채팅" },
    { kind: "playground" },
    { kind: "playgroundChat", chatId: null },
    { kind: "playgroundChat", chatId: "p/1" },
    { kind: "characters" },
    { kind: "settings", page: null },
    ...settingsPages.map((page): Route => ({ kind: "settings", page })),
    ...playgroundTools.map((tool): Route => ({ kind: "playgroundTool", tool })),
];

describe("formatRoute and parseRoute", () => {
    it("round-trips every route, ids with reserved and non-ASCII characters included", () => {
        for (const route of routes) {
            const path = formatRoute(route);
            expect(parseRoute(path), path).toEqual(route);
        }
    });

    it("formats the canonical paths", () => {
        expect(formatRoute({ kind: "home" })).toBe("/");
        expect(formatRoute({ kind: "chat", chaId: "§playground", chatId: "a/b" })).toBe("/chat/%C2%A7playground/a%2Fb");
        expect(formatRoute({ kind: "settings", page: "api-keys" })).toBe("/settings/api-keys");
        expect(formatRoute({ kind: "settings", page: null })).toBe("/settings");
        expect(formatRoute({ kind: "playgroundTool", tool: "image-gen" })).toBe("/playground/image-gen");
        expect(formatRoute({ kind: "playgroundChat", chatId: "c" })).toBe("/playground/chat/c");
    });

    it("ignores trailing slashes", () => {
        expect(parseRoute("//")).toEqual({ kind: "home" });
        expect(parseRoute("/settings/")).toEqual({ kind: "settings", page: null });
        expect(parseRoute("/chat/c1/x//")).toEqual({ kind: "chat", chaId: "c1", chatId: "x" });
    });

    it("tells the playground chat apart from the tools", () => {
        expect(parseRoute("/playground/chat")).toEqual({ kind: "playgroundChat", chatId: null });
        expect(parseRoute("/playground/tokenizer")).toEqual({ kind: "playgroundTool", tool: "tokenizer" });
    });

    it("rejects paths that name no route", () => {
        for (const path of [
            "",
            "settings",
            "/unknown",
            "/chat",
            "/chat/c1/x/extra",
            "/chat//x",
            "/chat/%E0%A4%A",
            "/realm/x",
            "/characters/x",
            "/settings/nope",
            "/settings/model/extra",
            "/settings/constructor",
            "/settings/__proto__",
            "/settings/hasOwnProperty",
            "/playground/nope",
            "/playground/__proto__",
            "/playground/tokenizer/extra",
            "/playground/chat/x/extra",
            "/Settings/model",
        ]) {
            expect(parseRoute(path), path).toBeNull();
        }
    });
});

describe("slug tables", () => {
    it("map each store value to one slug and back", () => {
        for (const page of settingsPages) {
            expect(settingsPageOf(SETTINGS_PAGES[page]), page).toBe(page);
        }
        for (const tool of playgroundTools) {
            expect(playgroundToolOf(PLAYGROUND_TOOLS[tool]), tool).toBe(tool);
        }
        expect(new Set(Object.values(SETTINGS_PAGES)).size).toBe(settingsPages.length);
        expect(new Set(Object.values(PLAYGROUND_TOOLS)).size).toBe(playgroundTools.length);
    });

    it("give the Language and Translation pages their own slugs", () => {
        expect(SETTINGS_PAGES.language).toBe(10);
        expect(SETTINGS_PAGES.translation).toBe(TRANSLATION_SETTINGS_MENU);
        expect(TRANSLATION_SETTINGS_MENU).toBe(21);
        expect(settingsPageOf(TRANSLATION_SETTINGS_MENU)).toBe("translation");
        expect(parseRoute("/settings/translation")).toEqual({ kind: "settings", page: "translation" });
    });

    it("give Memory, Image Generation and Voice their own slugs, and read the old bot slug as Memory", () => {
        expect([MEMORY_SETTINGS_MENU, IMAGE_GENERATION_SETTINGS_MENU, VOICE_SETTINGS_MENU]).toEqual([2, 19, 20]);
        expect(settingsPageOf(MEMORY_SETTINGS_MENU)).toBe("memory");
        expect(settingsPageOf(IMAGE_GENERATION_SETTINGS_MENU)).toBe("image-generation");
        expect(settingsPageOf(VOICE_SETTINGS_MENU)).toBe("voice");
        expect(Object.hasOwn(SETTINGS_PAGES, "bot")).toBe(false);
        for (const path of ["/settings/bot", "/settings/bot/"]) {
            expect(parseRoute(path), path).toEqual({ kind: "settings", page: "memory" });
        }
        expect(formatRoute(parseRoute("/settings/bot")!)).toBe("/settings/memory");
        for (const path of ["/settings/bot/extra", "/settings/Bot", "/playground/bot", "/bot"]) {
            expect(parseRoute(path), path).toBeNull();
        }
    });

    it("give no slug to the values without a route", () => {
        for (const index of [-1, 5, 7, 8, 9, 99]) {
            expect(settingsPageOf(index), String(index)).toBeNull();
        }
        for (const value of [0, 1, 2, 15, 100]) {
            expect(playgroundToolOf(value), String(value)).toBeNull();
        }
    });
});

describe("isClientRoutePath", () => {
    it("matches every path under a route segment, and every route but home", () => {
        for (const route of routes.filter((entry) => entry.kind !== "home")) {
            expect(isClientRoutePath(formatRoute(route)), formatRoute(route)).toBe(true);
        }
        for (const segment of CLIENT_ROUTE_SEGMENTS) {
            expect(isClientRoutePath(`/${segment}/anything/below`), segment).toBe(true);
        }
    });

    it("does not match other paths", () => {
        for (const path of ["/", "/index.html", "/chat.js", "/settingsX", "/api/chat", "/assets/settings", ""]) {
            expect(isClientRoutePath(path), path).toBe(false);
        }
    });
});
