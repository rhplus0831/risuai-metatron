import { settings, activePreset } from "./storage/settingsViews.svelte";
import { writable } from "svelte/store";
import type { character, Database, groupChat } from "./storage/database.svelte";
import { type simpleCharacterArgument } from "./parser/parser.svelte";
import type { alertData } from "./alert";
import { moduleUpdate } from "./process/modules";
import { resetTransformEffects } from "./parser/transformClient";
import type { hubType } from "./characterCards";
import { selectedCharacterIndex, selectedIndex } from "./storage/selection.svelte";

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
/**
 * The selected character as an index into `DBState.db.characters` (-1: home): an index view of
 * `selection.characterId` (`selection.svelte.ts`, Phase 6 slice 5). `set` selects the character at
 * that index; the value follows the character when the list changes around it.
 */
export const selectedCharID = selectedCharacterIndex;
export const CurrentTriggerIdStore = writable<string | null>(null);
export const CharEmotion = writable({} as { [key: string]: [string, string, number][] });
export const ViewBoxsize = writable({ width: 12 * 16, height: 12 * 16 }); // Default width and height in pixels
export const settingsOpen = writable(false);
export const botMakerMode = writable(false);
export const moduleBackgroundEmbedding = writable("");
export const openPresetList = writable(false);
export const openPersonaList = writable(false);
export const bookmarkListOpen = writable(false);
export const SettingsMenuIndex = writable(-1);
export const ReloadGUIPointer = writable(0);
export const ReloadChatPointer = writable({} as Record<number, number>);
export const ScrollToMessageStore = $state({ value: -1 });
export const OpenRealmStore = writable(false);
export const RealmInitialOpenChar = writable<null | hubType>(null);
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
/** `selectedCharID` as a reactive field (`selIdState.selId`), for runes code; writable the same way. */
export const selIdState = {
    get selId(): number {
        return selectedIndex();
    },
    set selId(index: number) {
        selectedCharID.set(index);
    },
};

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

export function createSimpleCharacter(char: character | groupChat) {
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
export const DBState = $state({
    db: {} as any as Database,
});

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
export const easyPanelStore = $state({
    open: false,
});
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

export const customSideBarConfigDialogStore = $state({
    open: false,
});

//Set might be more ideal, however since Svelte doesn't support reactive Sets, using array for now
export const hotReloading = $state<string[]>([]);

ReloadGUIPointer.subscribe(() => {
    ReloadChatPointer.set({});
    resetTransformEffects();
});

$effect.root(() => {
    $effect(() => {
        $state.snapshot(settings.modules);
        settings.enabledModules;
        settings.enabledModules?.length;
        DBState?.db?.characters?.[selIdState.selId]?.chats?.[DBState?.db?.characters?.[selIdState.selId]?.chatPage]
            ?.modules?.length;
        DBState?.db?.characters?.[selIdState.selId]?.hideChatIcon;
        DBState?.db?.characters?.[selIdState.selId]?.backgroundHTML;
        activePreset.moduleIntergration;
        moduleUpdate();
    });
});
