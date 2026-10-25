/**
 * Interaction Settings Data
 *
 * Data-driven definition for the InteractionSettings page: how the chat input sends, how messages are
 * edited and removed, how the menus and chat list behave, and the chat's context usage meter. Moved
 * from Accessibility (the `acc.` items) and Advanced (the `adv.` items), keeping their ids.
 */

import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";
import { DEFAULT_NEW_CHAT_BINDING } from "../../../shared/chatBinding.ts";
import { CONTEXT_METER_FIXED_WARN } from "../../../shared/database.ts";

export const interactionSettingsItems: SettingItem[] = [
    {
        id: "interaction.header",
        type: "header",
        labelKey: "interactionSettings",
        options: { level: "h2" },
    },
    {
        id: "acc.sendWithEnter",
        type: "check",
        labelKey: "sendWithEnter",
        bindKey: "sendWithEnter",
        keywords: ["send", "enter", "keyboard", "submit"],
    },
    {
        id: "acc.clickToEdit",
        type: "check",
        labelKey: "clickToEdit",
        bindKey: "clickToEdit",
        keywords: ["click", "edit", "message"],
    },
    {
        id: "acc.enableBlockPartialEdit",
        type: "check",
        labelKey: "enableBlockPartialEdit",
        bindKey: "enableBlockPartialEdit",
        keywords: ["partial", "edit", "block", "hover"],
    },
    {
        id: "acc.enableDragPartialEdit",
        type: "check",
        labelKey: "enableDragPartialEdit",
        bindKey: "enableDragPartialEdit",
        keywords: ["partial", "edit", "drag", "selection"],
    },
    {
        id: "acc.longPressToPopupEditor",
        type: "check",
        labelKey: "longPressToPopupEditor",
        bindKey: "longPressToPopupEditor",
        keywords: ["long", "press", "popup", "editor"],
    },
    {
        id: "acc.askRemoval",
        type: "check",
        labelKey: "askRemoval",
        bindKey: "askRemoval",
        keywords: ["ask", "removal", "confirm", "delete"],
    },
    {
        id: "acc.instantRemove",
        type: "check",
        labelKey: "instantRemove",
        bindKey: "instantRemove",
        keywords: ["instant", "remove", "delete"],
    },
    {
        id: "acc.swipe",
        type: "check",
        labelKey: "SwipeRegenerate",
        bindKey: "swipe",
        keywords: ["swipe", "regenerate", "gesture"],
    },
    {
        id: "acc.botSettingAtStart",
        type: "check",
        labelKey: "botSettingAtStart",
        bindKey: "botSettingAtStart",
        keywords: ["bot", "setting", "start", "open"],
    },
    {
        id: "acc.showMenuChatList",
        type: "check",
        labelKey: "showMenuChatList",
        bindKey: "showMenuChatList",
        keywords: ["menu", "chat", "list", "show"],
    },
    {
        id: "acc.showMenuHypaMemoryModal",
        type: "check",
        labelKey: "showMenuHypaMemoryModal",
        bindKey: "showMenuHypaMemoryModal",
        keywords: ["menu", "hypa", "memory", "modal"],
    },
    {
        id: "acc.sideMenuRerollButton",
        type: "check",
        labelKey: "sideMenuRerollButton",
        bindKey: "sideMenuRerollButton",
        keywords: ["side", "menu", "reroll", "button"],
    },
    {
        id: "acc.goCharacterOnImport",
        type: "check",
        labelKey: "goCharacterOnImport",
        bindKey: "goCharacterOnImport",
        keywords: ["character", "import", "navigate"],
    },
    {
        id: "acc.createFolderOnBranch",
        type: "check",
        labelKey: "createFolderOnBranch",
        bindKey: "createFolderOnBranch",
        keywords: ["create", "folder", "branch"],
    },
    {
        id: "acc.newChatBinding",
        type: "segmented",
        labelKey: "newChatBinding",
        bindKey: "newChatBinding",
        // Shown as the creation reads it (`initialChatBinding`): anything but `empty` is `inherit`, so
        // an unexpected value is not reset to the last option when the page opens.
        getValue: (ctx) => (ctx.settings.ui.newChatBinding === "empty" ? "empty" : DEFAULT_NEW_CHAT_BINDING),
        options: {
            segmentOptions: [
                { value: "inherit", labelKey: "newChatBindingInherit" },
                { value: "empty", labelKey: "newChatBindingEmpty" },
            ],
        },
        keywords: ["new", "chat", "preset", "persona", "binding", "inherit"],
    },
    // From Advanced; their `mt-4` (Advanced's spacing) went with the move.
    {
        id: "adv.scrollToActive",
        type: "check",
        labelKey: "enableScrollToActiveChar",
        bindKey: "enableScrollToActiveChar",
        helpKey: "enableScrollToActiveChar",
    },
    { id: "adv.bookmark", type: "check", labelKey: "bookmark", bindKey: "enableBookmark" },
    {
        id: "interaction.contextMeterEnabled",
        type: "check",
        labelKey: "contextMeter",
        bindKey: "contextMeter",
        keywords: ["context", "token", "meter", "usage", "history", "window"],
    },
    {
        id: "interaction.contextMeterTurnUnit",
        type: "segmented",
        labelKey: "contextMeterTurnUnit",
        helpKey: "contextMeterTurnUnit",
        bindKey: "contextMeterTurnUnit",
        condition: (ctx) => ctx.settings.ui.contextMeter,
        // Shown as the meter reads it: anything but `message` counts turns.
        getValue: (ctx) => (ctx.settings.ui.contextMeterTurnUnit === "message" ? "message" : "user"),
        options: {
            segmentOptions: [
                { value: "user", labelKey: "contextMeterTurnUnitUser" },
                { value: "message", labelKey: "contextMeterTurnUnitMessage" },
            ],
        },
        keywords: ["context", "turn", "message", "history", "window"],
    },
    {
        id: "interaction.contextMeterFixedWarn",
        type: "slider",
        labelKey: "contextMeterFixedWarn",
        helpKey: "contextMeterFixedWarn",
        bindKey: "contextMeterFixedWarn",
        condition: (ctx) => ctx.settings.ui.contextMeter,
        options: {
            min: CONTEXT_METER_FIXED_WARN.min,
            max: CONTEXT_METER_FIXED_WARN.max,
            customText: (value) => `${value}%`,
        },
        keywords: ["context", "fixed", "share", "warning", "prompt"],
    },
];

/** The page heading, above the sections. */
export const interactionSettingsHeader: SettingItem[] = itemsById(interactionSettingsItems, ["interaction.header"]);

export const interactionSettingsSections: SettingSection[] = [
    {
        id: "interaction.input",
        labelKey: "settingsSectionInput",
        items: itemsById(interactionSettingsItems, ["acc.sendWithEnter"]),
    },
    {
        id: "interaction.messageEditing",
        labelKey: "settingsSectionMessageEditing",
        items: itemsById(interactionSettingsItems, [
            "acc.clickToEdit",
            "acc.enableBlockPartialEdit",
            "acc.enableDragPartialEdit",
            "acc.longPressToPopupEditor",
            "acc.askRemoval",
            "acc.instantRemove",
            "acc.swipe",
        ]),
    },
    {
        id: "interaction.chatNavigation",
        labelKey: "settingsSectionChatNavigation",
        items: itemsById(interactionSettingsItems, [
            "acc.botSettingAtStart",
            "acc.showMenuChatList",
            "acc.showMenuHypaMemoryModal",
            "acc.sideMenuRerollButton",
            "acc.goCharacterOnImport",
            "acc.createFolderOnBranch",
            "acc.newChatBinding",
            "adv.scrollToActive",
            "adv.bookmark",
        ]),
    },
    {
        id: "interaction.contextMeter",
        labelKey: "settingsSectionContextMeter",
        descriptionKey: "settingsSectionContextMeterDesc",
        items: itemsById(interactionSettingsItems, [
            "interaction.contextMeterEnabled",
            "interaction.contextMeterTurnUnit",
            "interaction.contextMeterFixedWarn",
        ]),
    },
];
