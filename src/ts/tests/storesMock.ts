import { writable } from "svelte/store";
import { vi } from "vitest";
import { createAlertQueue } from "../alertQueue";
import * as settingsMenu from "../settingsMenu";
import type { PickerListState, MemoryProgressState } from "../stores.svelte";
import type { ChatRef } from "../storage/chatStore.svelte";

type StoresModule = typeof import("../stores.svelte");

/** Plain stores without the DOM, resize listeners, module effects, or CSS subscription.
 * Load inside each hoisted vi.mock factory and pass that file's handles as overrides.
 * Every call owns fresh state; adding a product export must update these defaults.
 */
export function createStoresMock(overrides: Partial<StoresModule> = {}): StoresModule {
    const defaults = {
        ...settingsMenu,
        SizeStore: writable({ w: 0, h: 0 }),
        loadedStore: writable(false),
        DynamicGUI: writable(false),
        sideBarClosing: writable(false),
        sideBarStore: writable(false),
        CurrentTriggerIdStore: writable<string | null>(null),
        CharEmotion: writable<Record<string, [string, string, number][]>>({}),
        ViewBoxsize: writable({ width: 192, height: 192 }),
        settingsOpen: writable(false),
        gridOpenStore: writable(false),
        botMakerMode: writable(false),
        moduleBackgroundEmbedding: writable(""),
        openPresetList: writable<PickerListState>(false),
        openModelPresetList: writable<PickerListState>(false),
        openPersonaList: writable<PickerListState>(false),
        chatBindingDialog: writable<ChatRef | null>(null),
        bookmarkListOpen: writable(false),
        SettingsMenuIndex: writable(-1),
        ReloadGUIPointer: writable(0),
        ReloadChatPointer: writable<Record<string, number>>({}),
        reloadChatKey: vi.fn<StoresModule["reloadChatKey"]>((id, idx) => (id !== undefined ? `m:${id}` : `i:${idx}`)),
        ScrollToMessageStore: { value: -1 },
        ShowLatestMessageStore: { value: false },
        OpenRealmStore: writable(false),
        PlaygroundStore: writable(0),
        HideIconStore: writable(false),
        CustomCSSStore: writable(""),
        SafeModeStore: writable(false),
        CharConfigSubMenu: writable(0),
        alertStore: createAlertQueue({ type: "none", msg: "n" }),
        hypaV3ModalOpen: writable(false),
        hypaV3ProgressStore: writable({ open: false, miniMsg: "", msg: "", subMsg: "" }),
        memoryProgressStore: writable<MemoryProgressState>({ runs: {}, chats: {}, legacy: null }),
        memoryProgressFor: vi.fn<StoresModule["memoryProgressFor"]>(() => null),
        legacyProgressShown: vi.fn<StoresModule["legacyProgressShown"]>(() => false),
        createSimpleCharacter: vi.fn<StoresModule["createSimpleCharacter"]>(() => null),
        LoadingStatusState: { text: "" },
        disableHighlight: writable(true),
        additionalSettingsMenu: [],
        additionalFloatingActionButtons: [],
        additionalHamburgerMenu: [],
        additionalChatMenu: [],
        chatPanelStore: [],
        bodyIntercepterStore: [],
        popupStore: { children: null, mouseX: 0, mouseY: 0, openId: 0 },
        popUpEditorStore: { open: false, value: "", mode: "default", language: "markdown" },
        irisStore: { open: false },
        hotReloading: [],
    } satisfies StoresModule;
    return { ...defaults, ...overrides };
}
