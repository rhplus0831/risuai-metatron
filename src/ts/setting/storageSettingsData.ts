import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

/** The Storage page's leaf items, shared by its renderers and settings search. */
export const storageSettingsItems: SettingItem[] = [
    {
        type: "header",
        id: "storage.header",
        labelKey: "storagePage.title",
        options: { level: "h2" },
        classes: "!mb-0",
    },
    {
        type: "header",
        id: "storage.description",
        labelKey: "storagePage.description",
        options: { level: "span" },
        classes: "!mt-1 !mb-0 text-sm !text-textcolor2",
    },
    {
        type: "custom",
        id: "adv.storagePanel",
        labelKey: "storagePage.overview.title",
        componentId: "StorageOverview",
        keywords: ["storage", "disk", "저장소", "용량"],
    },
    {
        type: "custom",
        id: "storage.cleanupPanel",
        labelKey: "storagePage.cleanup.title",
        componentId: "StorageCleanup",
        keywords: ["assets", "cleanup", "에셋", "정리"],
    },
    {
        type: "custom",
        id: "storage.snapshotsPanel",
        labelKey: "storagePage.snapshots.title",
        componentId: "StorageSnapshots",
        keywords: ["snapshot", "backup", "restore", "스냅샷", "백업", "복원"],
    },
    {
        type: "custom",
        id: "storage.ownersPanel",
        labelKey: "storagePage.owners.title",
        componentId: "StorageOwners",
        keywords: ["owners", "usage", "소유자", "사용량"],
    },
    {
        type: "custom",
        id: "storage.detailsPanel",
        labelKey: "storagePage.details.title",
        componentId: "StorageDetails",
        keywords: ["totals", "bytes", "세부", "합계"],
    },
];

/** The page heading and description, above the sections. */
export const storageSettingsHeader = itemsById(storageSettingsItems, ["storage.header", "storage.description"]);

/** Main controls stay visible; owner attribution and detailed totals open on demand. */
export const storageSettingsSections: SettingSection[] = [
    {
        id: "storage.overview",
        labelKey: "storagePage.overview.title",
        items: itemsById(storageSettingsItems, ["adv.storagePanel"]),
    },
    {
        id: "storage.cleanup",
        labelKey: "storagePage.cleanup.title",
        items: itemsById(storageSettingsItems, ["storage.cleanupPanel"]),
    },
    {
        id: "storage.snapshots",
        labelKey: "storagePage.snapshots.title",
        items: itemsById(storageSettingsItems, ["storage.snapshotsPanel"]),
    },
    {
        id: "storage.owners",
        labelKey: "storagePage.owners.title",
        collapsible: true,
        items: itemsById(storageSettingsItems, ["storage.ownersPanel"]),
    },
    {
        id: "storage.details",
        labelKey: "storagePage.details.title",
        collapsible: true,
        items: itemsById(storageSettingsItems, ["storage.detailsPanel"]),
    },
];
