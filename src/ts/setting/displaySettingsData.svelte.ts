/**
 * Display Settings Data
 *
 * Data-driven definition for the DisplaySettings page (settings UI plan slice 7): one leaf array,
 * `displaySettingsItems`, and `displaySettingsTabs`, the page's four tabs, each a list of sections built
 * over it by id.
 */

import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";
import { updateAnimationSpeed } from "../gui/animation";
import { guiSizeText, updateGuisize } from "../gui/guisize";
import { updateTextThemeAndCSS } from "../gui/colorscheme";

/** Every Display item, in tab and section order. */
export const displaySettingsItems: SettingItem[] = [
    // Theme tab: Interface style
    {
        id: "display.theme",
        type: "select",
        labelKey: "theme",
        bindKey: "theme",
        classes: "mt-4",
        options: {
            selectOptions: [
                { value: "metatron", labelKey: "metatronTheme" },
                { value: "", label: "Standard Risu" },
                { value: "waifu", label: "Waifulike" },
                { value: "mobilechat", label: "Mobile Chat" },
                { value: "cardboard", label: "CardBoard" },
                { value: "customHTML", label: "Custom HTML" },
            ],
        },
        keywords: ["theme", "gui", "layout"],
    },
    {
        id: "display.guiHTML",
        type: "textarea",
        labelKey: "chatHTML",
        helpKey: "chatHTML",
        bindKey: "guiHTML",
        condition: (ctx) => ctx.settings.ui.theme === "customHTML",
        keywords: ["custom", "html", "chat"],
    },
    {
        id: "display.waifuWidth",
        type: "slider",
        labelKey: "waifuWidth",
        bindKey: "waifuWidth",
        condition: (ctx) => ctx.settings.ui.theme === "waifu",
        options: {
            min: 50,
            max: 200,
            customText: (value) => `${value}%`,
        },
        classes: "mt-4",
        keywords: ["waifu", "width"],
    },
    {
        id: "display.waifuWidth2",
        type: "slider",
        labelKey: "waifuWidth2",
        bindKey: "waifuWidth2",
        condition: (ctx) => ctx.settings.ui.theme === "waifu",
        options: {
            min: 20,
            max: 150,
            customText: (value) => `${value}%`,
        },
        classes: "mt-4",
        keywords: ["waifu", "width"],
    },

    // Theme tab: Colors & typography
    {
        id: "display.colorScheme",
        type: "custom",
        componentId: "ColorSchemeSelect",
        keywords: ["color", "scheme", "theme"],
    },
    {
        id: "display.customColorScheme",
        type: "custom",
        componentId: "CustomColorSchemeEditor",
        condition: (ctx) => ctx.settings.ui.colorSchemeName === "custom",
        keywords: ["custom", "color", "scheme"],
    },
    {
        id: "display.textTheme",
        type: "select",
        labelKey: "textColor",
        bindKey: "textTheme",
        classes: "mt-4",
        onChange: () => updateTextThemeAndCSS(),
        options: {
            selectOptions: [
                { value: "standard", labelKey: "classicRisu" },
                { value: "highcontrast", labelKey: "highcontrast" },
                { value: "custom", label: "Custom" },
            ],
        },
        keywords: ["text", "color", "theme"],
    },
    {
        id: "display.customTextTheme",
        type: "custom",
        componentId: "CustomTextThemeEditor",
        condition: (ctx) => ctx.settings.ui.textTheme === "custom",
        keywords: ["custom", "text", "color", "theme"],
    },
    {
        id: "display.font",
        type: "select",
        labelKey: "font",
        bindKey: "font",
        classes: "mt-4",
        onChange: () => updateTextThemeAndCSS(),
        options: {
            selectOptions: [
                { value: "default", label: "Default" },
                { value: "timesnewroman", label: "Times New Roman" },
                { value: "custom", label: "Custom" },
            ],
        },
        keywords: ["font", "typeface"],
    },
    {
        id: "display.customFont",
        type: "text",
        fallbackLabel: "",
        bindKey: "customFont",
        condition: (ctx) => ctx.settings.ui.font === "custom",
        onChange: () => updateTextThemeAndCSS(),
        keywords: ["font", "custom"],
    },
    {
        id: "display.customBackground",
        type: "custom",
        componentId: "CustomBackgroundToggle",
        keywords: ["custom", "background"],
    },

    // Theme tab: Custom CSS
    {
        id: "display.customCSS",
        type: "textarea",
        labelKey: "customCSS",
        helpKey: "customCSS",
        bindKey: "customCSS",
        classes: "mt-4",
        onChange: () => updateTextThemeAndCSS(),
        keywords: ["custom", "css"],
    },

    // Layout & sizing tab: Element sizes
    {
        id: "display.zoomsize",
        type: "slider",
        labelKey: "UISize",
        bindKey: "zoomsize",
        classes: "mt-4",
        options: { min: 50, max: 200 },
        keywords: ["ui", "size", "zoom"],
    },
    {
        id: "display.lineHeight",
        type: "slider",
        labelKey: "lineHeight",
        bindKey: "lineHeight",
        options: { min: 0.5, max: 3, step: 0.05, fixed: 2 },
        keywords: ["line", "height", "spacing"],
    },
    {
        id: "display.chatScreenWidth",
        type: "slider",
        labelKey: "chatScreenWidth",
        bindKey: "chatScreenWidth",
        options: { min: 500, max: 2000, step: 10, customText: (value) => `${value}px` },
        keywords: ["chat", "screen", "width"],
    },
    {
        id: "display.iconsize",
        type: "slider",
        labelKey: "iconSize",
        bindKey: "iconsize",
        options: { min: 50, max: 200 },
        keywords: ["icon", "size"],
    },
    {
        id: "display.textAreaSize",
        type: "slider",
        labelKey: "textAreaSize",
        bindKey: "textAreaSize",
        onChange: () => updateGuisize(),
        options: {
            min: -5,
            max: 5,
            customText: (value) => guiSizeText(value),
        },
        keywords: ["textarea", "input", "size"],
    },
    {
        id: "display.textAreaTextSize",
        type: "slider",
        labelKey: "textAreaTextSize",
        bindKey: "textAreaTextSize",
        onChange: () => updateGuisize(),
        options: {
            min: 0,
            max: 3,
            customText: (value) => guiSizeText(value),
        },
        keywords: ["textarea", "text", "size"],
    },
    {
        id: "display.sideBarSize",
        type: "slider",
        labelKey: "sideBarSize",
        bindKey: "sideBarSize",
        onChange: () => updateGuisize(),
        options: {
            min: 0,
            max: 3,
            customText: (value) => guiSizeText(value),
        },
        keywords: ["sidebar", "size"],
    },
    {
        id: "display.animationSpeed",
        type: "slider",
        labelKey: "animationSpeed",
        bindKey: "animationSpeed",
        onChange: () => updateAnimationSpeed(),
        options: { min: 0, max: 1, step: 0.05, fixed: 2 },
        keywords: ["animation", "speed"],
    },
    {
        id: "display.settingsCloseButtonSize",
        type: "slider",
        labelKey: "settingsCloseButtonSize",
        helpKey: "settingsCloseButtonSize",
        bindKey: "settingsCloseButtonSize",
        options: { min: 16, max: 48, step: 1 },
        keywords: ["settings", "close", "button", "size"],
    },

    // Layout & sizing tab: Window & sidebar (`adv.heightMode` from Advanced, settings UI plan slice 7)
    {
        id: "adv.heightMode",
        type: "select",
        labelKey: "heightMode",
        bindKey: "heightMode",
        options: {
            selectOptions: [
                { value: "normal", label: "Normal" },
                { value: "percent", label: "Percent" },
                { value: "vh", label: "VH" },
                { value: "dvh", label: "DVH" },
                { value: "svh", label: "SVH" },
                { value: "lvh", label: "LVH" },
            ],
        },
    },
    {
        id: "display.menuSideBar",
        type: "check",
        labelKey: "menuSideBar",
        bindKey: "menuSideBar",
        keywords: ["menu", "sidebar"],
    },
    {
        id: "display.showFolderName",
        type: "check",
        labelKey: "showFolderNameInIcon",
        bindKey: "showFolderName",
        keywords: ["folder", "name", "icon"],
    },
    {
        id: "display.hideRealm",
        type: "check",
        labelKey: "hideRealm",
        bindKey: "hideRealm",
        keywords: ["realm", "hide"],
    },
    {
        id: "display.showSavingIcon",
        type: "check",
        labelKey: "showSavingIcon",
        bindKey: "showSavingIcon",
        keywords: ["saving", "icon"],
    },

    // Chat appearance tab: Messages
    {
        id: "display.showMemoryLimit",
        type: "check",
        labelKey: "showMemoryLimit",
        bindKey: "showMemoryLimit",
        keywords: ["memory", "limit"],
    },
    {
        id: "display.memoryLimitThickness",
        type: "slider",
        labelKey: "memoryLimitThickness",
        bindKey: "memoryLimitThickness",
        condition: (ctx) => ctx.settings.ui.showMemoryLimit,
        options: { min: 1, max: 500, step: 1 },
        keywords: ["memory", "limit", "thickness"],
    },
    {
        id: "display.showFirstMessagePages",
        type: "check",
        labelKey: "showFirstMessagePages",
        bindKey: "showFirstMessagePages",
        keywords: ["first", "message", "pages"],
    },
    {
        id: "display.roundIcons",
        type: "check",
        labelKey: "roundIcons",
        bindKey: "roundIcons",
        keywords: ["round", "icons"],
    },
    {
        id: "display.textScreenColor",
        type: "custom",
        componentId: "NullableTextColorToggle",
        componentProps: {
            field: "textScreenColor",
            labelKey: "textBackgrounds",
            defaultColor: "#121212",
        },
        keywords: ["text", "background", "color"],
    },
    {
        id: "display.textBorder",
        type: "check",
        labelKey: "textBorder",
        bindKey: "textBorder",
        keywords: ["text", "border"],
    },
    {
        id: "display.textScreenRounded",
        type: "check",
        labelKey: "textScreenRound",
        bindKey: "textScreenRounded",
        keywords: ["text", "round"],
    },
    {
        id: "display.textScreenBorder",
        type: "custom",
        componentId: "NullableTextColorToggle",
        componentProps: {
            field: "textScreenBorder",
            labelKey: "textScreenBorder",
            defaultColor: "#121212",
        },
        keywords: ["text", "screen", "border", "color"],
    },
    {
        id: "display.useChatCopy",
        type: "check",
        labelKey: "useChatCopy",
        bindKey: "useChatCopy",
        keywords: ["chat", "copy"],
    },
    {
        id: "display.unformatQuotes",
        type: "check",
        labelKey: "unformatQuotes",
        bindKey: "unformatQuotes",
        keywords: ["quotes"],
    },
    {
        id: "display.blockquoteStyling",
        type: "check",
        labelKey: "blockquoteStyling",
        bindKey: "blockquoteStyling",
        keywords: ["blockquote", "quote"],
    },
    {
        id: "display.customQuotes",
        type: "check",
        labelKey: "customQuotes",
        bindKey: "customQuotes",
        keywords: ["custom", "quotes"],
    },
    {
        id: "display.leadingDoubleQuote",
        type: "text",
        labelKey: "leadingDoubleQuote",
        condition: (ctx) => ctx.settings.ui.customQuotes,
        getValue: (ctx) => ctx.settings.ui.customQuotesData?.[0] ?? "",
        setValue: (value: string, ctx) => {
            ctx.settings.ui.customQuotesData ??= ['"', '"', "'", "'"];
            ctx.settings.ui.customQuotesData[0] = value;
        },
        keywords: ["quote", "double", "leading"],
    },
    {
        id: "display.trailingDoubleQuote",
        type: "text",
        labelKey: "trailingDoubleQuote",
        condition: (ctx) => ctx.settings.ui.customQuotes,
        getValue: (ctx) => ctx.settings.ui.customQuotesData?.[1] ?? "",
        setValue: (value: string, ctx) => {
            ctx.settings.ui.customQuotesData ??= ['"', '"', "'", "'"];
            ctx.settings.ui.customQuotesData[1] = value;
        },
        keywords: ["quote", "double", "trailing"],
    },
    {
        id: "display.leadingSingleQuote",
        type: "text",
        labelKey: "leadingSingleQuote",
        condition: (ctx) => ctx.settings.ui.customQuotes,
        getValue: (ctx) => ctx.settings.ui.customQuotesData?.[2] ?? "",
        setValue: (value: string, ctx) => {
            ctx.settings.ui.customQuotesData ??= ['"', '"', "'", "'"];
            ctx.settings.ui.customQuotesData[2] = value;
        },
        keywords: ["quote", "single", "leading"],
    },
    {
        id: "display.trailingSingleQuote",
        type: "text",
        labelKey: "trailingSingleQuote",
        condition: (ctx) => ctx.settings.ui.customQuotes,
        getValue: (ctx) => ctx.settings.ui.customQuotesData?.[3] ?? "",
        setValue: (value: string, ctx) => {
            ctx.settings.ui.customQuotesData ??= ['"', '"', "'", "'"];
            ctx.settings.ui.customQuotesData[3] = value;
        },
        keywords: ["quote", "single", "trailing"],
    },
    {
        id: "display.useChatSticker",
        type: "check",
        labelKey: "useChatSticker",
        helpKey: "unrecommended",
        helpUnrecommended: true,
        bindKey: "useChatSticker",
        condition: (ctx) => ctx.settings.ui.showUnrecommended,
        keywords: ["chat", "sticker"],
    },

    // Chat appearance tab: Media
    {
        id: "display.hideAllImages",
        type: "check",
        labelKey: "hideAllImages",
        helpKey: "hideAllImagesDesc",
        bindKey: "hideAllImages",
        keywords: ["images", "hide"],
    },
    {
        id: "display.assetWidth",
        type: "slider",
        labelKey: "assetWidth",
        bindKey: "assetWidth",
        classes: "mt-4",
        options: {
            min: -1,
            max: 40,
            step: 1,
            customText: (value) => (value === -1 ? "Unlimited" : value === 0 ? "Hidden" : `${value.toFixed(1)} rem`),
        },
        keywords: ["asset", "width"],
    },
    {
        id: "display.useAdditionalAssetsPreview",
        type: "check",
        labelKey: "useAdditionalAssetsPreview",
        bindKey: "useAdditionalAssetsPreview",
        keywords: ["additional", "assets", "preview"],
    },

    // Sound & notifications tab: Sound (`adv.keepSessionAlive` from Advanced, slice 7)
    {
        id: "display.playMessage",
        type: "check",
        labelKey: "playMessage",
        helpKey: "msgSound",
        bindKey: "playMessage",
        keywords: ["message", "sound"],
    },
    {
        id: "display.playMessageOnTranslateEnd",
        type: "check",
        labelKey: "playMessageOnTranslateEnd",
        bindKey: "playMessageOnTranslateEnd",
        keywords: ["translate", "sound"],
    },
    {
        id: "adv.keepSessionAlive",
        type: "select",
        labelKey: "keepSessionAlive",
        bindKey: "keepSessionAlive",
        helpKey: "keepSessionAlive",
        options: {
            selectOptions: [
                { value: "off", label: "Off" },
                { value: "sound", label: "Via Sound" },
            ],
        },
    },

    // Sound & notifications tab: Notifications
    { id: "display.notification", type: "custom", componentId: "NotificationToggle", keywords: ["notification"] },
];

/** A tab of the Display page: its label and its sections. */
export interface DisplaySettingsTab {
    id: string;
    labelKey: string;
    sections: SettingSection[];
}

/**
 * The Display page's tabs (archived, `docs/archived-plan/README.md`, slice 7), over `displaySettingsItems`. The
 * legacy GUI (`settings.ui.useLegacyGUI`) stacks them in this order with no tab bar.
 */
export const displaySettingsTabs: DisplaySettingsTab[] = [
    {
        id: "theme",
        labelKey: "theme",
        sections: [
            {
                id: "display.theme.style",
                labelKey: "settingsSectionInterfaceStyle",
                items: itemsById(displaySettingsItems, [
                    "display.theme",
                    "display.guiHTML",
                    "display.waifuWidth",
                    "display.waifuWidth2",
                ]),
            },
            {
                id: "display.theme.colors",
                labelKey: "settingsSectionColorsTypography",
                items: itemsById(displaySettingsItems, [
                    "display.colorScheme",
                    "display.customColorScheme",
                    "display.textTheme",
                    "display.customTextTheme",
                    "display.font",
                    "display.customFont",
                    "display.customBackground",
                ]),
            },
            {
                id: "display.theme.customCSS",
                labelKey: "settingsSectionCustomCSS",
                descriptionKey: "settingsSectionCustomCSSDesc",
                collapsible: true,
                items: itemsById(displaySettingsItems, ["display.customCSS"]),
            },
        ],
    },
    {
        id: "layout",
        labelKey: "displayTabLayout",
        sections: [
            {
                id: "display.layout.sizes",
                labelKey: "settingsSectionElementSizes",
                items: itemsById(displaySettingsItems, [
                    "display.zoomsize",
                    "display.lineHeight",
                    "display.chatScreenWidth",
                    "display.iconsize",
                    "display.textAreaSize",
                    "display.textAreaTextSize",
                    "display.sideBarSize",
                    "display.animationSpeed",
                    "display.settingsCloseButtonSize",
                ]),
            },
            {
                id: "display.layout.window",
                labelKey: "settingsSectionWindowSidebar",
                items: itemsById(displaySettingsItems, [
                    "adv.heightMode",
                    "display.menuSideBar",
                    "display.showFolderName",
                    "display.hideRealm",
                    "display.showSavingIcon",
                ]),
            },
        ],
    },
    {
        id: "chat",
        labelKey: "displayTabChatAppearance",
        sections: [
            {
                id: "display.chat.messages",
                labelKey: "settingsSectionMessages",
                items: itemsById(displaySettingsItems, [
                    "display.showMemoryLimit",
                    "display.memoryLimitThickness",
                    "display.showFirstMessagePages",
                    "display.roundIcons",
                    "display.textScreenColor",
                    "display.textBorder",
                    "display.textScreenRounded",
                    "display.textScreenBorder",
                    "display.useChatCopy",
                    "display.unformatQuotes",
                    "display.blockquoteStyling",
                    "display.customQuotes",
                    "display.leadingDoubleQuote",
                    "display.trailingDoubleQuote",
                    "display.leadingSingleQuote",
                    "display.trailingSingleQuote",
                    "display.useChatSticker",
                ]),
            },
            {
                id: "display.chat.media",
                labelKey: "settingsSectionMedia",
                items: itemsById(displaySettingsItems, [
                    "display.hideAllImages",
                    "display.assetWidth",
                    "display.useAdditionalAssetsPreview",
                ]),
            },
        ],
    },
    {
        id: "sound",
        labelKey: "displayTabSoundNotifications",
        sections: [
            {
                id: "display.sound.sound",
                labelKey: "settingsSectionSound",
                items: itemsById(displaySettingsItems, [
                    "display.playMessage",
                    "display.playMessageOnTranslateEnd",
                    "adv.keepSessionAlive",
                ]),
            },
            {
                id: "display.sound.notifications",
                labelKey: "settingsSectionNotifications",
                items: itemsById(displaySettingsItems, ["display.notification"]),
            },
        ],
    },
];

/** The tab another page asked Display to open on its next mount (`requestDisplayTab`), or null. */
let requestedDisplayTab: string | null = null;

/** Make the next Display mount open the tab with this id (the Accessibility page's sizes link). */
export function requestDisplayTab(id: string): void {
    requestedDisplayTab = id;
}

/** The index of the requested tab, or 0 (Theme) when none was asked for; the request is used up. */
export function takeRequestedDisplayTab(): number {
    const index = displaySettingsTabs.findIndex((tab) => tab.id === requestedDisplayTab);
    requestedDisplayTab = null;
    return Math.max(0, index);
}

/** Every section of every tab, in tab order: the legacy GUI's stacked page. */
export const displaySettingsSections: SettingSection[] = displaySettingsTabs.flatMap((tab) => tab.sections);
