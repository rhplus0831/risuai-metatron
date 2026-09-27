import { alertError, alertNormal, alertStore, alertWait, alertMd, alertConfirm } from "../alert";
import { LocalWriter, forageStorage, requiresFullEncoderReload } from "../globalApi.svelte";
import { decodeRisuSave, encodeRisuSaveLegacy } from "../storage/risuSave";
import { getDatabase, setDatabaseLite } from "../storage/database.svelte";
import { sleep } from "../util";
import { language } from "src/lang";

function getBasename(data: string) {
    const baseNameRegex = /\\/g;
    const splited = data.replace(baseNameRegex, "/").split("/");
    const lasts = splited[splited.length - 1];
    return lasts;
}

export async function SaveLocalBackup() {
    alertWait("Saving local backup...");
    const db = getDatabase();

    const writer = new LocalWriter();
    const r = await writer.init();
    if (!r) {
        alertError("Failed");
        return;
    }

    const assetMap = new Map<string, { charName: string; assetName: string }>();
    if (db.characters) {
        for (const char of db.characters) {
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
    }
    if (db.userIcon) {
        assetMap.set(db.userIcon, { charName: "User Settings", assetName: "User Icon" });
    }
    if (db.customBackground) {
        assetMap.set(db.customBackground, { charName: "User Settings", assetName: "Custom Background" });
    }
    const missingAssets: string[] = [];

    const keys = await forageStorage.keys();

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        let message = `Saving local Backup... (${i + 1} / ${keys.length})`;
        if (missingAssets.length > 0) {
            const skippedItems = missingAssets
                .map((key) => {
                    const assetInfo = assetMap.get(key);
                    return assetInfo ? `'${assetInfo.assetName}' from ${assetInfo.charName}` : `'${key}'`;
                })
                .join(", ");
            message += `\n(Skipping... ${skippedItems})`;
        }
        alertWait(message);

        if (!key || !key.endsWith(".png")) {
            continue;
        }
        const data = (await forageStorage.getItem(key)) as unknown as Uint8Array;

        if (data) {
            await writer.writeBackup(key, data);
        } else {
            missingAssets.push(key);
        }
    }

    const dbData = encodeRisuSaveLegacy(db, "compression");

    alertWait(`Saving local Backup... (Saving database)`);

    await writer.writeBackup("database.risudat", dbData);
    await writer.close();

    if (missingAssets.length > 0) {
        let message = "Backup Successful, but the following assets were missing and skipped:\n\n";
        for (const key of missingAssets) {
            const assetInfo = assetMap.get(key);
            if (assetInfo) {
                message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`;
            } else {
                message += `* **Unknown Asset**  \n  *File: ${key}*\n`;
            }
        }
        alertMd(message);
    } else {
        alertNormal("Success");
    }
}

/**
 * Saves a partial local backup with only critical assets.
 *
 * Differences from SaveLocalBackup:
 * - Only includes profile images for characters/groups (excludes emotion images, additional assets, VITS files, CC assets)
 * - Additionally includes: persona icons, folder images, bot preset images
 * - Processes only assets in assetMap (selective) instead of all .png files in assets folder
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

    alertWait("Saving partial local backup...");
    const db = getDatabase();

    const writer = new LocalWriter();
    const r = await writer.init();
    if (!r) {
        alertError("Failed");
        return;
    }

    const assetMap = new Map<string, { charName: string; assetName: string }>();

    // Only collect main profile images for both characters and groups
    if (db.characters) {
        for (const char of db.characters) {
            if (!char) continue;
            const charName = char.name ?? "Unknown Character";

            // Save the main profile image (supports both character and group types)
            // Note: emotionImages are intentionally excluded from partial backup
            if (char.image) {
                assetMap.set(char.image, { charName: charName, assetName: "Profile Image" });
            }
        }
    }

    // User icon
    if (db.userIcon) {
        assetMap.set(db.userIcon, { charName: "User Settings", assetName: "User Icon" });
    }

    // Persona icons
    if (db.personas) {
        for (const persona of db.personas) {
            if (persona && persona.icon) {
                assetMap.set(persona.icon, { charName: "Persona", assetName: `${persona.name} Icon` });
            }
        }
    }

    // Custom background
    if (db.customBackground) {
        assetMap.set(db.customBackground, { charName: "User Settings", assetName: "Custom Background" });
    }

    // Folder images in characterOrder
    if (db.characterOrder) {
        for (const item of db.characterOrder) {
            if (typeof item !== "string" && item.img) {
                assetMap.set(item.img, { charName: "Folder", assetName: `${item.name} Folder Image` });
            }
            if (typeof item !== "string" && item.imgFile) {
                assetMap.set(item.imgFile, { charName: "Folder", assetName: `${item.name} Folder Image File` });
            }
        }
    }

    // Bot preset images
    if (db.botPresets) {
        for (const preset of db.botPresets) {
            if (preset && preset.image) {
                assetMap.set(preset.image, { charName: "Preset", assetName: `${preset.name} Preset Image` });
            }
        }
    }

    const missingAssets: string[] = [];

    const keys = await forageStorage.keys();
    const assetKeys = Array.from(assetMap.keys());

    for (let i = 0; i < assetKeys.length; i++) {
        const key = assetKeys[i];
        let message = `Saving partial local backup... (${i + 1} / ${assetKeys.length})`;
        if (missingAssets.length > 0) {
            const skippedItems = missingAssets
                .map((key) => {
                    const assetInfo = assetMap.get(key);
                    return assetInfo ? `'${assetInfo.assetName}' from ${assetInfo.charName}` : `'${key}'`;
                })
                .join(", ");
            message += `\n(Skipping... ${skippedItems})`;
        }
        alertWait(message);

        if (!key || !key.endsWith(".png")) {
            continue;
        }

        const data = (await forageStorage.getItem(key)) as unknown as Uint8Array;

        if (data) {
            await writer.writeBackup(key, data);
        } else {
            missingAssets.push(key);
        }
    }

    const dbData = encodeRisuSaveLegacy(db, "compression");

    alertWait(`Saving partial local backup... (Saving database)`);

    await writer.writeBackup("database.risudat", dbData);
    await writer.close();

    if (missingAssets.length > 0) {
        let message = "Partial backup successful, but the following profile images were missing and skipped:\n\n";
        for (const key of missingAssets) {
            const assetInfo = assetMap.get(key);
            if (assetInfo) {
                message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`;
            } else {
                message += `* **Unknown Asset**  \n  *File: ${key}*\n`;
            }
        }
        alertMd(message);
    } else {
        alertNormal("Success");
    }
}

/**
 * Scans only the record headers of a local backup for `encryption.risudat`, which Risu Account
 * backups wrote before their encrypted database. Uses random-access slices, so no record data is read.
 */
async function isAccountEncryptedBackup(file: File): Promise<boolean> {
    const readU32 = async (at: number) => new DataView(await file.slice(at, at + 4).arrayBuffer()).getUint32(0, true);
    let offset = 0;
    while (offset + 4 <= file.size) {
        const nameLength = await readU32(offset);
        if (offset + 4 + nameLength + 4 > file.size) {
            return false;
        }
        const name = new TextDecoder().decode(await file.slice(offset + 4, offset + 4 + nameLength).arrayBuffer());
        if (name === "encryption.risudat") {
            return true;
        }
        const dataLength = await readU32(offset + 4 + nameLength);
        offset += 4 + nameLength + 4 + dataLength;
    }
    return false;
}

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

            alertWait("Checking local Backup...");
            if (await isAccountEncryptedBackup(file)) {
                alertError("This backup was encrypted with a Risu Account and can no longer be restored.");
                return;
            }

            const reader = file.stream().getReader();
            const CHUNK_SIZE = 1024 * 1024; // 1MB chunk size
            let bytesRead = 0;
            let remainingBuffer = new Uint8Array();
            let pendingDatabase: Uint8Array | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                bytesRead += value.length;
                const progress = ((bytesRead / file.size) * 100).toFixed(2);
                alertWait(`Loading local Backup... (${progress}%)`);

                const newBuffer = new Uint8Array(remainingBuffer.length + value.length);
                newBuffer.set(remainingBuffer);
                newBuffer.set(value, remainingBuffer.length);
                remainingBuffer = newBuffer;

                let offset = 0;
                while (offset + 4 <= remainingBuffer.length) {
                    const nameLength = new Uint32Array(remainingBuffer.slice(offset, offset + 4).buffer)[0];

                    if (offset + 4 + nameLength > remainingBuffer.length) {
                        break;
                    }
                    const nameBuffer = remainingBuffer.slice(offset + 4, offset + 4 + nameLength);
                    const name = new TextDecoder().decode(nameBuffer);

                    if (offset + 4 + nameLength + 4 > remainingBuffer.length) {
                        break;
                    }
                    const dataLength = new Uint32Array(
                        remainingBuffer.slice(offset + 4 + nameLength, offset + 4 + nameLength + 4).buffer,
                    )[0];

                    if (offset + 4 + nameLength + 4 + dataLength > remainingBuffer.length) {
                        break;
                    }
                    const data = remainingBuffer.slice(
                        offset + 4 + nameLength + 4,
                        offset + 4 + nameLength + 4 + dataLength,
                    );

                    if (name === "database.risudat") {
                        pendingDatabase = new Uint8Array(data);
                    } else if (name.startsWith("coldstorage_") && name.endsWith(".json")) {
                        // Record from removed cold storage in an older backup; nothing reads it anymore.
                    } else {
                        await forageStorage.setItem("assets/" + name, data);
                    }
                    await sleep(10);

                    offset += 4 + nameLength + 4 + dataLength;
                }
                remainingBuffer = remainingBuffer.slice(offset);
            }

            if (!pendingDatabase) {
                alertError("Failed, Is file corrupted?");
                return;
            }

            const db = pendingDatabase;
            const dbData = await decodeRisuSave(db);

            setDatabaseLite(dbData);
            requiresFullEncoderReload.state = true;
            await forageStorage.setItem("database/database.bin", db);
            location.search = "";
            alertStore.set({
                type: "wait",
                msg: "Success, Refreshing your app.",
            });

            alertNormal("Success");
        };

        input.click();
    } catch (error) {
        console.error(error);
        alertError("Failed, Is file corrupted?");
    }
}
