import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The popup editor is one modal shared by every field that can open it. A session id names the
// opener a given open belongs to: a stale opener (a field that lost its popup to a newer open, or a
// closed popup's own callbacks) can neither close a newer session nor write its text back. The
// module graph beyond the records is mocked as in `stores.simpleCharacter.test.ts`.

vi.mock("./storage/characterStore.svelte", () => ({ selectedCharacter: () => null }));
vi.mock("./storage/chatStore.svelte", () => ({
    selectedChat: () => null,
    currentChatRef: () => null,
    findChat: () => undefined,
    heldChatRevision: () => null,
    isMessageLocked: () => false,
}));
vi.mock("./storage/settingsViews.svelte", () => ({
    settings: { modules: [], enabledModules: [] },
    activePreset: { id: "preset", moduleIntergration: "" },
    activePersona: { id: "persona" },
}));
vi.mock("./process/modules", () => ({ moduleUpdate: vi.fn() }));
vi.mock("./parser/parser.svelte", () => ({}));
vi.mock("./alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lang", () => ({ language: {} }));
vi.mock("./network/generationJobs", () => ({ generationClientId: () => "client" }));
vi.mock("./plugins/apiV3/pluginContext", () => ({ capturePluginContext: () => undefined, invokeHook: vi.fn() }));
vi.mock("./plugins/pluginHooks", () => ({ pluginHooks: {} }));
vi.mock("./storage/serverAuth", () => ({ authFetch: vi.fn() }));
vi.mock("./storage/resourceClient", () => ({ epochMismatch: () => false, getResourceEpoch: () => "" }));
vi.mock("./util", () => ({ checkPersonaBinded: () => undefined }));

import {
    closePopupEditorSession,
    isPopupEditorSessionCurrent,
    openPopupEditorSession,
    popUpEditorStore,
} from "./stores.svelte";

const initial = { ...popUpEditorStore };

beforeEach(() => Object.assign(popUpEditorStore, initial));
afterEach(() => Object.assign(popUpEditorStore, initial));

describe("popup editor sessions", () => {
    it("opens with the field's text and language under a fresh id that the store shows as current", () => {
        const first = openPopupEditorSession("first draft", "lua");
        expect(popUpEditorStore).toMatchObject({
            open: true,
            value: "first draft",
            language: "lua",
            mode: "default",
            sessionId: first,
        });
        expect(isPopupEditorSessionCurrent(first)).toBe(true);

        const second = openPopupEditorSession("second draft");
        expect(second).not.toBe(first);
        expect(popUpEditorStore).toMatchObject({ open: true, value: "second draft", language: "markdown" });
        expect(isPopupEditorSessionCurrent(first)).toBe(false);
        expect(isPopupEditorSessionCurrent(second)).toBe(true);
    });

    it("closes only the current session, so a stale opener leaves a newer popup open", () => {
        const first = openPopupEditorSession("first draft");
        const second = openPopupEditorSession("second draft");

        expect(closePopupEditorSession(first)).toBe(false);
        expect(popUpEditorStore.open).toBe(true);
        expect(closePopupEditorSession(second)).toBe(true);
        expect(popUpEditorStore.open).toBe(false);
        // The closed session stays the current one until the next open, so its owner can still tell
        // that the popup it opened is the one that closed.
        expect(isPopupEditorSessionCurrent(second)).toBe(true);
    });
});
