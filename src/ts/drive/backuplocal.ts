import { alertError, alertNormal, alertStore, alertWait, alertMd, alertConfirm } from "../alert";
import { LocalWriter } from "../globalApi.svelte";
import { buildBackupInventory, type BackupInventory } from "../storage/snapshots.svelte";
import { language } from "src/lang";
import { type BackupArchiveManifest, RESOURCE_KIND } from "../../../shared/resources.ts";
import { selectPartialBackupAssets } from "../../../shared/backups.ts";
import { exportBackup, importBackup, ResourceEpochMismatchError } from "../storage/resourceClient";
import { flushResources } from "../storage/resourceSync.svelte";

/**
 * Local backup archives, built and restored by the server (`/api/backups/export` and `/import`):
 * a `manifest.json` record, the resource database snapshot (`resources.sqlite`), and the assets under
 * their logical keys. Archives from before this format (holding `database.risudat`) are refused by
 * the server.
 */

type AssetInfo = { charName: string; assetName: string };

/** Assets the characters and settings reference, for the missing-asset report. */
function referencedAssets(db: BackupInventory): Map<string, AssetInfo> {
    const assetMap = new Map<string, AssetInfo>();
    for (const char of db.characters ?? []) {
        if (!char) continue;
        const charName = char.name ?? "Unknown Character";

        if (char.image) assetMap.set(char.image, { charName: charName, assetName: "Main Image" });

        if (char.emotionImages) {
            for (const em of char.emotionImages) {
                if (em && em[1]) assetMap.set(em[1], { charName: charName, assetName: em[0] });
            }
        }
        if (char.type !== "group") {
            if (char.additionalAssets) {
                for (const em of char.additionalAssets) {
                    if (em && em[1]) assetMap.set(em[1], { charName: charName, assetName: em[0] });
                }
            }
            if (char.vits) {
                const keys = Object.keys(char.vits.files);
                for (const key of keys) {
                    const vit = char.vits.files[key];
                    if (vit) assetMap.set(vit, { charName: charName, assetName: key });
                }
            }
            if (char.ccAssets) {
                for (const asset of char.ccAssets) {
                    if (asset && asset.uri) assetMap.set(asset.uri, { charName: charName, assetName: asset.name });
                }
            }
        }
    }
    if (db.userIcon) {
        assetMap.set(db.userIcon, { charName: "User Settings", assetName: "User Icon" });
    }
    if (db.customBackground) {
        assetMap.set(db.customBackground, { charName: "User Settings", assetName: "Custom Background" });
    }
    return assetMap;
}

/** The profile images a partial backup keeps. */
function partialAssets(db: BackupInventory): Map<string, AssetInfo> {
    const assetMap = new Map<string, AssetInfo>();
    const entries = selectPartialBackupAssets([
        ...(db.characters ?? []).map((data) => ({ kind: RESOURCE_KIND.characters, data })),
        { kind: RESOURCE_KIND.personas, data: db.personas },
        { kind: RESOURCE_KIND.ui, data: { customBackground: db.customBackground } },
        { kind: RESOURCE_KIND.characterOrder, data: db.characterOrder },
        { kind: RESOURCE_KIND.presets, data: db.botPresets },
    ]);
    for (const { key, owner, role } of entries) {
        const labels: Record<typeof role, AssetInfo> = {
            profile: { charName: owner || "Unknown Character", assetName: "Profile Image" },
            persona: { charName: "Persona", assetName: `${owner} Icon` },
            background: { charName: "User Settings", assetName: "Custom Background" },
            folder: { charName: "Folder", assetName: `${owner} Folder Image` },
            folderFile: { charName: "Folder", assetName: `${owner} Folder Image File` },
            preset: { charName: "Preset", assetName: `${owner} Preset Image` },
        };
        assetMap.set(key, labels[role]);
    }
    return assetMap;
}

function formatSize(bytes: number) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Reads the manifest (the first record) from the head of the archive stream. */
function tryReadManifest(head: Uint8Array): BackupArchiveManifest | null {
    if (head.length < 4) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const nameLength = view.getUint32(0, true);
    if (head.length < 8 + nameLength) return null;
    const dataLength = view.getUint32(4 + nameLength, true);
    if (head.length < 8 + nameLength + dataLength) return null;
    const bytes = head.subarray(8 + nameLength, 8 + nameLength + dataLength);
    return JSON.parse(new TextDecoder().decode(bytes)) as BackupArchiveManifest;
}

/**
 * Saves every change, asks the server for an archive, and streams it to a file. Returns the manifest.
 */
async function downloadArchive(label: string, partial?: true | string[]): Promise<BackupArchiveManifest | null> {
    alertWait(`${label}...`);
    try {
        await flushResources();
    } catch (error) {
        alertError(`Could not save your latest changes before the backup: ${error}`);
        return null;
    }
    const response = await exportBackup(partial);
    const reader = response.body!.getReader();
    const writer = new LocalWriter();
    let finished = false;
    try {
        if (!(await writer.init())) {
            alertError("Failed");
            return null;
        }
        let head = new Uint8Array(0);
        let manifest: BackupArchiveManifest | null = null;
        let total = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            await writer.write(value);
            total += value.byteLength;
            if (!manifest) {
                const next = new Uint8Array(head.length + value.length);
                next.set(head);
                next.set(value, head.length);
                head = next;
                manifest = tryReadManifest(head);
                if (manifest) {
                    head = new Uint8Array(0);
                }
            }
            alertWait(`${label}... (${formatSize(total)})`);
        }
        await writer.close();
        finished = true;
        return manifest;
    } finally {
        if (!finished) {
            // A cancelled or failed download: stop the server's export stream and drop the partial file.
            await reader.cancel().catch(() => {});
            await writer.writer?.abort().catch(() => {});
        }
    }
}

function reportMissing(missing: string[], assetMap: Map<string, AssetInfo>, intro: string) {
    if (missing.length === 0) {
        alertNormal("Success");
        return;
    }
    let message = intro;
    for (const key of missing) {
        const assetInfo = assetMap.get(key);
        if (assetInfo) {
            message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`;
        } else {
            message += `* **Unknown Asset**  \n  *File: ${key}*\n`;
        }
    }
    alertMd(message);
}

/** A full backup: the resource database and every asset on the server. */
export async function SaveLocalBackup() {
    try {
        const assetMap = referencedAssets(buildBackupInventory());
        const manifest = await downloadArchive("Saving local Backup");
        if (!manifest) {
            return;
        }
        const stored = new Set(manifest.assets);
        const missing = [...assetMap.keys()].filter((key) => key.startsWith("assets/") && !stored.has(key));
        reportMissing(missing, assetMap, "Backup Successful, but the following assets were missing and skipped:\n\n");
    } catch (error) {
        console.error(error);
        alertError(`Backup failed: ${error}`);
    }
}

/**
 * Saves a partial local backup with only critical assets.
 *
 * Differences from SaveLocalBackup:
 * - Only includes profile images for characters/groups (excludes emotion images, additional assets, VITS files, CC assets, inlays)
 * - Additionally includes: persona icons, folder images, bot preset images
 * - Faster and more efficient for quick backups
 * - Ideal for backing up core visual identity without bulk data
 */
export async function SavePartialLocalBackup() {
    // First confirmation: Explain the difference from regular backup
    const firstConfirm = await alertConfirm(language.partialBackupFirstConfirm);

    if (!firstConfirm) {
        return;
    }

    // Second confirmation: Final warning about not saving assets
    const secondConfirm = await alertConfirm(language.partialBackupSecondConfirm);

    if (!secondConfirm) {
        return;
    }

    try {
        const assetMap = partialAssets(buildBackupInventory());
        const manifest = await downloadArchive("Saving partial local backup", true);
        if (!manifest) {
            return;
        }
        reportMissing(
            manifest.missing,
            assetMap,
            "Partial backup successful, but the following profile images were missing and skipped:\n\n",
        );
    } catch (error) {
        console.error(error);
        alertError(`Backup failed: ${error}`);
    }
}

/**
 * Restores a local backup archive through the server: it replaces every resource, adds the archive's
 * assets that are missing (existing files are kept), then the app reloads.
 */
export function LoadLocalBackup() {
    try {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".bin";
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) {
                input.remove();
                return;
            }
            const file = input.files[0];
            input.remove();

            alertWait("Restoring local Backup...");
            try {
                await importBackup(file);
            } catch (error) {
                if (error instanceof ResourceEpochMismatchError) {
                    // The server data changed since this tab loaded it; reload and try again.
                    location.reload();
                    return;
                }
                console.error(error);
                alertError(error instanceof Error ? error.message : String(error));
                return;
            }
            alertStore.set({
                type: "wait",
                msg: "Success, Refreshing your app.",
            });
            location.reload();
        };

        input.click();
    } catch (error) {
        console.error(error);
        alertError("Failed, Is file corrupted?");
    }
}
