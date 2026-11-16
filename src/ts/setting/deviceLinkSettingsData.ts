/**
 * Device Link Settings Data
 *
 * Data-driven definition for the DeviceLinkSettings page: the controls that let a tab on another
 * device run this browser's sends (remote host) or take over a job's plugin steps (job handoff).
 * Every value here is device-local (`localStorage`), not a synced setting. The two custom items
 * moved from Display, keeping their ids.
 */

import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

export const deviceLinkSettingsItems: SettingItem[] = [
    {
        id: "deviceLink.header",
        type: "header",
        labelKey: "deviceLink.title",
        options: { level: "h2" },
    },
    {
        id: "display.remoteHost",
        type: "custom",
        componentId: "RemoteHostControls",
        keywords: ["remote", "host", "device", "send", "plugin", "reload"],
    },
    {
        id: "display.handoff",
        type: "custom",
        componentId: "HandoffToggles",
        keywords: ["handoff", "worker", "device"],
    },
];

/** The page heading, above the sections. */
export const deviceLinkSettingsHeader: SettingItem[] = itemsById(deviceLinkSettingsItems, ["deviceLink.header"]);

/** Remote host first: it is the recommended way, and job handoff covers what it does not take. */
export const deviceLinkSettingsSections: SettingSection[] = [
    {
        id: "deviceLink.remoteHost",
        labelKey: "deviceLink.remoteHostSection",
        items: itemsById(deviceLinkSettingsItems, ["display.remoteHost"]),
    },
    {
        id: "deviceLink.handoff",
        labelKey: "deviceLink.handoffSection",
        items: itemsById(deviceLinkSettingsItems, ["display.handoff"]),
    },
];
