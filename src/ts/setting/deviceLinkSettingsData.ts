/**
 * Device Link Settings Data
 *
 * Data-driven definition for the DeviceLinkSettings page: the controls that let a tab on another
 * device run this browser's sends (remote host) or take over a job's plugin steps (job handoff).
 * Every value here is device-local (`localStorage`), not a synced setting, which the page's note
 * says. `display.remoteHost` and `display.handoff` moved from Display, keeping their ids.
 */

import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

export const deviceLinkSettingsItems: SettingItem[] = [
    {
        id: "deviceLink.header",
        type: "header",
        labelKey: "deviceLink.title",
        options: { level: "h2" },
        classes: "!mb-0",
    },
    {
        id: "deviceLink.localNote",
        type: "header",
        labelKey: "deviceLink.localNote",
        options: { level: "span" },
        classes: "!mt-2 !mb-0 rounded-md border border-darkborderc p-2 text-sm !text-textcolor2",
    },
    {
        id: "deviceLink.description",
        type: "header",
        labelKey: "deviceLink.description",
        options: { level: "span" },
        classes: "!mt-2 !mb-0 text-sm !text-textcolor2",
    },
    {
        id: "deviceLink.name",
        type: "custom",
        labelKey: "deviceLink.name",
        componentId: "DeviceNameInput",
        keywords: ["name", "client", "device", "host", "worker", "이름"],
    },
    {
        id: "display.remoteHost",
        type: "custom",
        componentId: "RemoteHostControls",
        keywords: ["remote", "host", "device", "send", "plugin", "reload", "fallback", "원격", "호스트", "전송"],
    },
    {
        id: "deviceLink.startHost",
        type: "custom",
        labelKey: "serverJob.remoteHost.label",
        componentId: "HostModeButton",
        keywords: ["remote", "host", "mode", "lock", "start", "원격", "호스트"],
    },
    {
        id: "display.handoff",
        type: "custom",
        componentId: "HandoffToggles",
        keywords: ["handoff", "worker", "device", "takeover", "인계"],
    },
];

/** The heading, the device-local note, the description and this browser's name, above the sections. */
export const deviceLinkSettingsHeader: SettingItem[] = itemsById(deviceLinkSettingsItems, [
    "deviceLink.header",
    "deviceLink.localNote",
    "deviceLink.description",
    "deviceLink.name",
]);

/**
 * One section per mechanism, and the page draws a rule between them. Remote host comes first: it is
 * the recommended one, and job handoff covers the sends that stay on the sending device. Entering
 * host mode is a button (also on the home screen), so the two mechanisms never read as two
 * look-alike switches.
 */
export const deviceLinkSettingsSections: SettingSection[] = [
    {
        id: "deviceLink.remoteHost",
        labelKey: "deviceLink.remoteHostSection",
        descriptionKey: "deviceLink.remoteHostDescription",
        items: itemsById(deviceLinkSettingsItems, ["display.remoteHost", "deviceLink.startHost"]),
    },
    {
        id: "deviceLink.handoff",
        labelKey: "deviceLink.handoffSection",
        descriptionKey: "deviceLink.handoffDescription",
        items: itemsById(deviceLinkSettingsItems, ["display.handoff"]),
    },
];
