import { RESOURCE_KIND } from "./resources.ts";

/** A partial-backup reference and its display owner; roles are shared with the tab's missing-asset labels. */
export type PartialBackupAsset = {
    key: string;
    owner: string;
    role: "profile" | "persona" | "background" | "folder" | "folderFile" | "preset";
};

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * The asset categories of a partial archive: character/group profile images, persona icons (the
 * selected user icon lives on its persona), UI background, folder images (`img` and `imgFile`), and
 * prompt-preset images. Inlays, emotions, additional assets, VITS files, and card assets are excluded.
 * Only logical `assets/` keys qualify; duplicate keys keep the last owner/role.
 * `server/src/routes/backups.ts` selects from the snapshot it archives; the inventory in
 * `src/ts/drive/backuplocal.ts` uses this only to label missing keys, never to select server files.
 */
export function selectPartialBackupAssets(records: Iterable<{ kind: string; data: unknown }>): PartialBackupAsset[] {
    const assets = new Map<string, PartialBackupAsset>();
    const add = (key: unknown, owner: unknown, role: PartialBackupAsset["role"]) => {
        if (typeof key === "string" && key.startsWith("assets/")) {
            assets.set(key, { key, owner: typeof owner === "string" ? owner : "", role });
        }
    };
    for (const { kind, data } of records) {
        if (kind === RESOURCE_KIND.characters) {
            const character = object(data);
            add(character.image, character.name, "profile");
        } else if (kind === RESOURCE_KIND.ui) {
            add(object(data).customBackground, "", "background");
        } else if (Array.isArray(data)) {
            for (const value of data) {
                const item = object(value);
                switch (kind) {
                    case RESOURCE_KIND.personas:
                        add(item.icon, item.name, "persona");
                        break;
                    case RESOURCE_KIND.characterOrder:
                        add(item.img, item.name, "folder");
                        add(item.imgFile, item.name, "folderFile");
                        break;
                    case RESOURCE_KIND.presets:
                        add(item.image, item.name, "preset");
                        break;
                }
            }
        }
    }
    return [...assets.values()];
}
