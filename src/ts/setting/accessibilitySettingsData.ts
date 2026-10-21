/**
 * Accessibility Settings Data
 *
 * Data-driven definition for the AccessibilitySettings page: scrolling to new messages and keeping the
 * chat input and menu within reach; the page ends with a link to Display's sizes. The interaction
 * preferences that shared this page moved to the Interaction page (`interactionSettingsData.ts`), the
 * lorebook ones to Memory, the developer ones to Advanced, and the additional parameters toggle to
 * Model.
 */

import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";
import { language } from "src/lang";

export const accessibilitySettingsItems: SettingItem[] = [
    // Header
    {
        id: "acc.header",
        type: "header",
        labelKey: "accessibility",
        options: { level: "h2" },
    },
    {
        id: "acc.autoScrollToNewMessage",
        type: "check",
        labelKey: "autoScrollToNewMessage",
        bindKey: "autoScrollToNewMessage",
        keywords: ["auto", "scroll", "new", "message"],
    },
    {
        id: "acc.alwaysScrollToNewMessage",
        type: "check",
        labelKey: "alwaysScrollToNewMessage",
        bindKey: "alwaysScrollToNewMessage",
        condition: (ctx) => ctx.settings.ui.autoScrollToNewMessage,
        keywords: ["always", "scroll", "new", "message"],
    },
    {
        id: "acc.newMessageButtonStyle",
        type: "select",
        labelKey: "newMessageButtonStyle",
        bindKey: "newMessageButtonStyle",
        condition: (ctx) => ctx.settings.ui.autoScrollToNewMessage && !ctx.settings.ui.alwaysScrollToNewMessage,
        options: {
            selectOptions: [
                { value: "bottom-center", label: language.newMessageButtonBottomCenter },
                { value: "bottom-right", label: language.newMessageButtonBottomRight },
                { value: "bottom-left", label: language.newMessageButtonBottomLeft },
                { value: "floating-circle", label: language.newMessageButtonFloatingCircle },
                { value: "right-center", label: language.newMessageButtonRightCenter },
                { value: "top-bar", label: language.newMessageButtonTopBar },
            ],
        },
    },
    {
        id: "acc.fixedChatTextarea",
        type: "check",
        labelKey: "fixedChatTextarea",
        bindKey: "fixedChatTextarea",
        keywords: ["fixed", "chat", "textarea", "input"],
    },
    {
        id: "acc.hamburgerButtonBottom",
        type: "check",
        labelKey: "hamburgerButtonBottom",
        bindKey: "hamburgerButtonBottom",
        keywords: ["hamburger", "button", "bottom", "menu", "sidebar", "accessibility"],
    },
];

/** The page heading, above the sections. */
export const accessibilitySettingsHeader: SettingItem[] = itemsById(accessibilitySettingsItems, ["acc.header"]);

export const accessibilitySettingsSections: SettingSection[] = [
    {
        id: "accessibility.scrolling",
        labelKey: "settingsSectionScrolling",
        items: itemsById(accessibilitySettingsItems, [
            "acc.autoScrollToNewMessage",
            "acc.alwaysScrollToNewMessage",
            "acc.newMessageButtonStyle",
        ]),
    },
    {
        id: "accessibility.reachability",
        labelKey: "settingsSectionReachability",
        items: itemsById(accessibilitySettingsItems, ["acc.fixedChatTextarea", "acc.hamburgerButtonBottom"]),
    },
];
