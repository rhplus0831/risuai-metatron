import { DEFAULT_NEW_CHAT_BINDING, isNewChatBinding } from "../../../../shared/chatBinding.ts";
import { defaultColorScheme } from "../../../../shared/colorScheme.ts";
import {
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    normalizeChatLoadPages,
} from "../../../../shared/chatLoadPages.ts";
import { CONTEXT_METER_FIXED_WARN } from "../../../../shared/database.ts";
import type { SectionResource } from "../../../../shared/resources.ts";
import { isPlainObject, normalizeSection, plainClone, type SectionSpec } from "./shared.ts";

/** The `ui` section: display, input, and behavior options of this client. */
const spec: SectionSpec<"ui"> = {
    askRemoval: ["boolean", true],
    jailbreakToggle: ["boolean", false],
    language: ["string", "en"],
    zoomsize: ["number", 100],
    customBackground: ["string", ""],
    playMessage: ["boolean", false],
    iconsize: ["number", 100],
    theme: ["string", "metatron"],
    waifuWidth: ["number", 100],
    waifuWidth2: ["number", 100],
    swipe: ["boolean", true],
    instantRemove: ["boolean"],
    textTheme: ["string", "standard"],
    customTextTheme: [
        "object",
        {
            FontColorStandard: "#f8f8f2",
            FontColorBold: "#f8f8f2",
            FontColorItalic: "#8C8D93",
            FontColorItalicBold: "#8C8D93",
            FontColorQuote1: "#8BE9FD",
            FontColorQuote2: "#FFB86C",
        },
    ],
    useSayNothing: ["boolean", true],
    didFirstSetup: ["boolean"],
    showUnrecommended: ["boolean", false],
    useExperimental: ["boolean"],
    roundIcons: ["boolean"],
    textScreenColor: ["string"],
    textBorder: ["boolean"],
    textScreenRounded: ["boolean"],
    textScreenBorder: ["string"],
    sendWithEnter: ["boolean", true],
    fixedChatTextarea: ["boolean"],
    clickToEdit: ["boolean"],
    enableBlockPartialEdit: ["boolean", false],
    enableDragPartialEdit: ["boolean", false],
    useAutoSuggestions: ["boolean"],
    autoSuggestPrefix: ["string", ""],
    autoSuggestClean: ["boolean", true],
    useChatCopy: ["boolean"],
    classicMaxWidth: ["boolean", false],
    chatScreenWidth: ["number", 900],
    useChatSticker: ["boolean"],
    useAdditionalAssetsPreview: ["boolean"],
    personaNote: ["boolean"],
    assetWidth: ["number", -1],
    animationSpeed: ["number", 0.4],
    botSettingAtStart: ["boolean"],
    hideRealm: ["boolean"],
    blockedRealmCreators: ["array", []],
    colorScheme: ["object", defaultColorScheme],
    colorSchemeName: ["string", "default"],
    customColorScheme: ["object", defaultColorScheme],
    showMenuChatList: ["boolean"],
    allowAllExtentionFiles: ["boolean"],
    memoryLimitThickness: ["number", 1],
    sideMenuRerollButton: ["boolean"],
    requestInfoInsideChat: ["boolean"],
    heightMode: ["string", "normal"],
    textAreaSize: ["number", 0],
    sideBarSize: ["number", 0],
    textAreaTextSize: ["number", 0],
    dynamicAssetsEditDisplay: ["boolean"],
    goCharacterOnImport: ["boolean"],
    font: ["string", "default"],
    customFont: ["string", ""],
    lineHeight: ["number", 1.25],
    useLegacyGUI: ["boolean"],
    hideApiKey: ["boolean", true],
    unformatQuotes: ["boolean", false],
    enableDevTools: ["boolean"],
    customCSS: ["string", ""],
    customQuotes: ["boolean", false],
    customQuotesData: ["array", ["“", "”", "‘", "’"]],
    guiHTML: ["string"],
    notification: ["boolean"],
    assetMaxDifference: ["number", 4],
    menuSideBar: ["boolean"],
    showSavingIcon: ["boolean", false],
    showPromptComparison: ["boolean", false],
    bulkEnabling: ["boolean"],
    showTranslationLoading: ["boolean"],
    returnCSSError: ["boolean", true],
    localActivationInGlobalLorebook: ["boolean"],
    showFolderName: ["boolean"],
    showMenuHypaMemoryModal: ["boolean"],
    promptInfoInsideChat: ["boolean"],
    promptTextInfoInsideChat: ["boolean"],
    showFirstMessagePages: ["boolean", false],
    enableScrollToActiveChar: ["boolean", true],
    settingsCloseButtonSize: ["number", 24],
    promptDiffPrefs: ["object"],
    enableBookmark: ["boolean"],
    hideAllImages: ["boolean", false],
    autoScrollToNewMessage: ["boolean", true],
    alwaysScrollToNewMessage: ["boolean", false],
    scrollToReplyStartAfterStreaming: ["boolean", true],
    newMessageButtonStyle: ["string", "bottom-center"],
    chatLoadInitialPages: ["number", 30],
    chatLoadAdditionalPages: ["number", 15],
    streamingDisplayOptimizationMode: ["string", "off"],
    createFolderOnBranch: ["boolean", true],
    newChatBinding: ["string", DEFAULT_NEW_CHAT_BINDING],
    hamburgerButtonBottom: ["boolean", false],
    blockquoteStyling: ["boolean"],
    keepSessionAlive: ["string", "off"],
    longPressToPopupEditor: ["boolean", false],
    irisDialogue: ["array"],
    legacyMediaFindings: ["boolean"],
    showMemoryLimit: ["boolean", false],
    showDeprecatedTriggerV2: ["boolean", false],
    moveInsteadOfCopyOnCMPConvert: ["boolean", false],
    pluginDevelopMode: ["boolean"],
    memoryAlgorithmType: ["string"],
    forceProxyAsOpenAI: ["boolean"],
    contextMeter: ["boolean", true],
    contextMeterTurnUnit: ["string", "user"],
    contextMeterFixedWarn: ["number", CONTEXT_METER_FIXED_WARN.default],
};

export function normalizeUi(input: unknown): SectionResource<"ui"> {
    const record = normalizeSection("ui", spec, input);
    const creatorIds = new Set<string>();
    record.blockedRealmCreators = (record.blockedRealmCreators as unknown[]).flatMap((creator) => {
        if (!isPlainObject(creator) || typeof creator.id !== "string" || !creator.id || creatorIds.has(creator.id)) {
            return [];
        }
        creatorIds.add(creator.id);
        return [{ id: creator.id, name: typeof creator.name === "string" ? creator.name : creator.id }];
    });
    // A custom scheme saved before `customColorScheme` existed lived in `colorScheme`.
    const source = isPlainObject(input) ? input : {};
    if (!isPlainObject(source.customColorScheme) && record.colorSchemeName === "custom") {
        record.customColorScheme = plainClone(record.colorScheme);
    }
    if (!isNewChatBinding(record.newChatBinding)) {
        record.newChatBinding = DEFAULT_NEW_CHAT_BINDING;
    }
    if (record.contextMeterTurnUnit !== "message") {
        record.contextMeterTurnUnit = "user";
    }
    // The kind check already replaced a non-finite number with the default.
    record.contextMeterFixedWarn = Math.min(
        CONTEXT_METER_FIXED_WARN.max,
        Math.max(CONTEXT_METER_FIXED_WARN.min, record.contextMeterFixedWarn as number),
    );
    if (isPlainObject(record.customTextTheme)) {
        record.customTextTheme.FontColorQuote1 ??= "#8BE9FD";
        record.customTextTheme.FontColorQuote2 ??= "#FFB86C";
    }
    record.chatLoadInitialPages = normalizeChatLoadPages(record.chatLoadInitialPages, DEFAULT_CHAT_LOAD_INITIAL_PAGES);
    record.chatLoadAdditionalPages = normalizeChatLoadPages(
        record.chatLoadAdditionalPages,
        DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    );
    return record as SectionResource<"ui">;
}
