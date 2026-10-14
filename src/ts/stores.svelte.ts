import { type AnyClientCharacter, selectedCharacter } from "./storage/characterStore.svelte";
import { selectedChat, type ChatRef } from "./storage/chatStore.svelte";
import { settings, activePreset } from "./storage/settingsViews.svelte";
import { writable } from "svelte/store";
import { type simpleCharacterArgument } from "./parser/parser.svelte";
import type { alertData } from "./alert";
import { moduleUpdate } from "./process/modules";
import { resetTransformEffects } from "./parser/transformClient";

function updateSize() {
    SizeStore.set({
        w: window.innerWidth,
        h: window.innerHeight,
    });
    DynamicGUI.set(window.innerWidth <= 1024);
}

export const SizeStore = writable({
    w: 0,
    h: 0,
});

export const loadedStore = writable(false);
export const DynamicGUI = writable(false);
export const sideBarClosing = writable(false);
export const sideBarStore = writable(window.innerWidth > 1024);
export const CurrentTriggerIdStore = writable<string | null>(null);
export const CharEmotion = writable({} as { [key: string]: [string, string, number][] });
export const ViewBoxsize = writable({ width: 12 * 16, height: 12 * 16 }); // Default width and height in pixels
export const settingsOpen = writable(false);
export const gridOpenStore = writable(false);
export const botMakerMode = writable(false);
export const moduleBackgroundEmbedding = writable("");
/**
 * Whether a picker list is open: `true` opens it for what the screen shows (the open chat's binding,
 * else the tab's selection), `{ chatRef }` for that chat's binding (the binding panel's rows).
 */
export type PickerListState = boolean | { chatRef: ChatRef };
/** The prompt preset list (`botpreset.svelte`, kind `prompt`). */
export const openPresetList = writable<PickerListState>(false);
/** The model preset list (`botpreset.svelte`, kind `model`). */
export const openModelPresetList = writable<PickerListState>(false);
export const openPersonaList = writable<PickerListState>(false);
/** The chat whose binding dialog is open (`ChatBindingDialog.svelte`), or null. */
export const chatBindingDialog = writable<ChatRef | null>(null);
export const bookmarkListOpen = writable(false);
export const SettingsMenuIndex = writable(-1);
export {
    MODEL_SETTINGS_MENU,
    API_KEYS_SETTINGS_MENU,
    MODEL_PROFILES_SETTINGS_MENU,
    PROMPT_SETTINGS_MENU,
} from "./settingsMenu";
export const ReloadGUIPointer = writable(0);
/** Re-render counters of chat rows, by `reloadChatKey` (the message id, so an index shift keeps them). */
export const ReloadChatPointer = writable({} as Record<string, number>);
/**
 * A row's key in `ReloadChatPointer`: its message id, or its index for a row without one (the
 * greeting). Prefixed, so the two never meet and no id reads an `Object.prototype` member.
 */
export function reloadChatKey(messageId: string | undefined, idx: number): string {
    return messageId !== undefined ? `m:${messageId}` : `i:${idx}`;
}
export const ScrollToMessageStore = $state({ value: -1 });
export const OpenRealmStore = writable(false);
export const PlaygroundStore = writable(0);
export const HideIconStore = writable(false);
export const CustomCSSStore = writable("");
export const SafeModeStore = writable(false);
export const CharConfigSubMenu = writable(0);
export const CustomGUISettingMenuStore = writable(false);
export const alertStore = writable({
    type: "none",
    msg: "n",
} as alertData);
export const hypaV3ModalOpen = writable(false);
export const hypaV3ProgressStore = writable({
    open: false,
    miniMsg: "",
    msg: "",
    subMsg: "",
});

CustomCSSStore.subscribe((css) => {
    console.log(css);
    const q = document.querySelector("#customcss");
    if (q) {
        q.innerHTML = css;
    } else {
        const s = document.createElement("style");
        s.id = "customcss";
        s.innerHTML = css;
        document.body.appendChild(s);
    }
});

export function createSimpleCharacter(char: AnyClientCharacter | null | undefined) {
    if (!char || char.type === "group") {
        return null;
    }

    const simpleChar: simpleCharacterArgument = {
        type: "simple",
        customscript: char.customscript,
        chaId: char.chaId,
        additionalAssets: char.additionalAssets,
        emotionImages: char.emotionImages,
        triggerscript: char.triggerscript,
    };

    return simpleChar;
}

updateSize();
window.addEventListener("resize", updateSize);
export const LoadingStatusState = $state({
    text: "",
});

export const QuickSettings = $state({
    open: false,
    index: 0,
});

export const disableHighlight = writable(true);

export type MenuDef = {
    name: string;
    icon: string;
    iconType: "html" | "img" | "none";
    callback: any;
    id: string;
};

export type ChatPanelDef = {
    id: string;
    pluginName: string;
    html: string;
    className?: string;
};

export const additionalSettingsMenu = $state([] as MenuDef[]);
export const additionalFloatingActionButtons = $state([] as MenuDef[]);
export const additionalHamburgerMenu = $state([] as MenuDef[]);
export const additionalChatMenu = $state([] as MenuDef[]);
export const chatPanelStore = $state([] as ChatPanelDef[]);
export const bodyIntercepterStore = $state(
    [] as {
        id: string;
        callback: (body: any, type: string) => Promise<any>;
    }[],
);
export const popupStore = $state({
    children: null as null | import("svelte").Snippet,
    mouseX: 0,
    mouseY: 0,
    openId: 0,
});
export const popUpEditorStore = $state({
    open: false,
    value: "",
    mode: "default" as "default",
    language: "markdown" as string,
});

export const irisStore = $state({
    open: false,
});

//Set might be more ideal, however since Svelte doesn't support reactive Sets, using array for now
export const hotReloading = $state<string[]>([]);

// `subscribe` calls back at once, while this module is still evaluating; that first call has nothing
// to reset, and calling into `transformClient` then (which imports this module) can reach it before
// its own bindings exist. So the first call is skipped.
let guiPointerSubscribed = false;
ReloadGUIPointer.subscribe(() => {
    if (!guiPointerSubscribed) {
        guiPointerSubscribed = true;
        return;
    }
    ReloadChatPointer.set({});
    resetTransformEffects();
});

$effect.root(() => {
    $effect(() => {
        $state.snapshot(settings.modules);
        settings.enabledModules;
        settings.enabledModules?.length;
        selectedChat()?.modules?.length;
        selectedCharacter()?.hideChatIcon;
        selectedCharacter()?.backgroundHTML;
        activePreset.moduleIntergration;
        moduleUpdate();
    });
});
