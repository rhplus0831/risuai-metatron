import { alertError, alertNormal, alertStore, alertWait, alertMd, alertConfirm } from "../alert";
import { LocalWriter } from "../globalApi.svelte";
import { buildBackupInventory, type BackupInventory } from "../storage/snapshots.svelte";
import { language } from "src/lang";
import { type BackupArchiveManifest, RESOURCE_KIND } from "../../../shared/resources.ts";
import { selectPartialBackupAssets } from "../../../shared/backups.ts";
import { exportBackup, importBackup, ResourceEpochMismatchError } from "../storage/resourceClient";
import { flushResources, refusedItems } from "../storage/resourceSync.svelte";
import { findCharacter } from "../storage/characterStore.svelte";
import { chatEntry } from "../storage/chatStore.svelte";
import type { UpstreamExportCounts, UpstreamExportReport } from "../../../shared/upstreamExportReport.ts";

/**
 * Local backup archives, built and restored by the server (`/api/backups/export` and `/import`):
 * a `manifest.json` record, the resource database snapshot (`resources.sqlite`), and the assets under
 * their logical keys. Any other archive (an upstream RisuAI backup holding `database.risudat`, or one
 * of this app's from before this format) is restored through the upstream import
 * (`upstreamBackupClient.ts`). `SaveUpstreamLocalBackup` saves the other way: a `.bin` upstream RisuAI
 * restores.
 */

type AssetInfo = { charName: string; assetName: string };

/**
 * Full-backup missing warnings cover this tab's character/group images and emotions, character
 * additional/VITS/card assets, selected user icon, and background. Other resource references are
 * outside this inventory; the server's full export still includes every existing asset file.
 */
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

/**
 * Labels only: `shared/backups.ts` owns the categories and `server/src/routes/backups.ts` selects
 * from the archived snapshot. A manifest key absent from this tab's inventory remains "Unknown Asset".
 */
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
 * Flushes changes, asks the server for an archive, and streams it to a file. Returns the manifest
 * with the flush's discarded and refused keys: the archive holds the server's copy of those,
 * so the success report says which local changes it lacks.
 */
async function downloadArchive(
    label: string,
    partial?: true | string[],
): Promise<{ manifest: BackupArchiveManifest; discarded: string[]; refused: string[] } | null> {
    alertWait(`${label}...`);
    let discarded: string[];
    let refused: string[];
    try {
        ({ discarded, refused } = await flushResources());
    } catch (error) {
        alertError(`Could not save your latest changes before the backup: ${error}`);
        return null;
    }
    const response = await exportBackup(partial);
    // Read from the stream head (written by the chunk callback).
    const read: { head: Uint8Array; manifest: BackupArchiveManifest | null } = {
        head: new Uint8Array(0),
        manifest: null,
    };
    const saved = await streamToFile(response, label, "Binary", (value) => {
        if (!read.manifest) {
            const next = new Uint8Array(read.head.length + value.length);
            next.set(read.head);
            next.set(value, read.head.length);
            read.head = next;
            read.manifest = tryReadManifest(read.head);
            if (read.manifest) {
                read.head = new Uint8Array(0);
            }
        }
    });
    return saved && read.manifest ? { manifest: read.manifest, discarded, refused } : null;
}

/**
 * Streams a download into a file `LocalWriter` saves as `<name>.bin`, with the written size in a wait
 * alert, and hands each chunk to `onChunk` after it is written. False when the writer cannot open
 * ("Failed" is shown). A failed or cancelled download cancels the response and drops the partial file,
 * and throws.
 */
async function streamToFile(
    response: Response,
    label: string,
    name: string,
    onChunk: (value: Uint8Array) => void = () => {},
): Promise<boolean> {
    const reader = response.body!.getReader();
    const writer = new LocalWriter();
    let finished = false;
    try {
        if (!(await writer.init(name))) {
            alertError("Failed");
            return false;
        }
        let total = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            await writer.write(value);
            total += value.byteLength;
            onChunk(value);
            alertWait(`${label}... (${formatSize(total)})`);
        }
        await writer.close();
        finished = true;
        return true;
    } finally {
        if (!finished) {
            // A cancelled or failed download: stop the server's export stream and drop the partial file.
            await reader.cancel().catch(() => {});
            await writer.writer?.abort().catch(() => {});
        }
    }
}

/**
 * Uses the refusal banner's chat/order labels (`src/ts/storage/resourceSync.svelte.ts` `refusedItems`),
 * falling back to ids or unmatched report keys. Refused keys returned by a successful flush do not
 * stop the export; the warning says the archive holds the server's copy without those local changes.
 * A thrown flush refusal stops before export preparation.
 */
function backupRefusedNote(refused: string[]): string {
    if (refused.length === 0) return "";
    const labels = new Map<string, string>();
    for (const item of refusedItems()) {
        if (item.kind === "chat" || item.kind === "order") {
            const characterName = findCharacter(item.chaId)?.name || item.chaId;
            if (item.kind === "order") {
                labels.set(`chats/${item.chaId}`, language.refusedData.orderLabel(characterName));
            } else {
                const entry = chatEntry(item);
                labels.set(
                    `chats/${item.chaId}/${item.chatId}`,
                    entry
                        ? language.refusedData.chatLabel(entry.name || item.chatId, characterName)
                        : language.refusedData.deletedChat(characterName, item.chatId),
                );
            }
        }
    }
    return [language.backupRefusedChanges, ...refused.map((key) => `- ${labels.get(key) ?? key}`)].join("\n");
}

/**
 * Discarded/refused flush warnings precede missing assets, or accompany success when none are missing.
 * A discarded edit was replaced by another writer's server copy; a key absent from the inventory is
 * "Unknown Asset". `src/ts/alert.ts` keeps reload notices in a separate store.
 */
function reportMissing(
    missing: string[],
    assetMap: Map<string, AssetInfo>,
    intro: string,
    discarded: string[],
    refused: string[],
) {
    const saveNote = [discarded.length > 0 ? language.backupDiscardedChanges : "", backupRefusedNote(refused)]
        .filter(Boolean)
        .join("\n\n");
    if (missing.length === 0) {
        alertNormal(saveNote ? `Success\n\n${saveNote}` : "Success");
        return;
    }
    let message = saveNote ? `${saveNote}\n\n${intro}` : intro;
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

/** The longest record name an archive holds (`server/src/data/archive.ts`). */
const MAX_RECORD_NAME_BYTES = 4096;

/**
 * The name of an archive's first record, or null when the file does not start with a readable record
 * header (or cannot be read): `manifest.json` for this app's version-2 archives.
 */
export async function readFirstRecordName(file: Blob): Promise<string | null> {
    let head: Uint8Array;
    try {
        head = new Uint8Array(await file.slice(0, 4 + MAX_RECORD_NAME_BYTES).arrayBuffer());
    } catch {
        return null;
    }
    if (head.length < 4) {
        return null;
    }
    const length = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, true);
    if (length === 0 || 4 + length > head.length) {
        return null;
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(4, 4 + length));
    } catch {
        return null;
    }
}

/**
 * A full archive of the server's resource snapshot and every server asset, inlays included
 * (`server/src/routes/backups.ts`). The tab's missing-asset inventory is captured before the flush
 * in `downloadArchive` and compared with the returned manifest, rather than rebuilt from the archived
 * resource snapshot. Inventoried references absent from the manifest's assets are reported with
 * discarded/refused keys returned by the successful flush.
 */
export async function SaveLocalBackup() {
    try {
        const assetMap = referencedAssets(buildBackupInventory());
        const result = await downloadArchive("Saving local Backup");
        if (!result) {
            return;
        }
        const stored = new Set(result.manifest.assets);
        const missing = [...assetMap.keys()].filter((key) => key.startsWith("assets/") && !stored.has(key));
        reportMissing(
            missing,
            assetMap,
            "Backup Successful, but the following assets were missing and skipped:\n\n",
            result.discarded,
            result.refused,
        );
    } catch (error) {
        console.error(error);
        alertError(`Backup failed: ${error}`);
    }
}

/**
 * Both `partialBackupFirstConfirm` and `partialBackupSecondConfirm` must be accepted before flushing
 * and requesting `{ partial: true }`. The resource snapshot is retained; only assets are restricted,
 * by `shared/backups.ts` `selectPartialBackupAssets` on the server's archived copy
 * (`server/src/routes/backups.ts`). The tab's `partialAssets` labels the manifest's missing entries.
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
        const result = await downloadArchive("Saving partial local backup", true);
        if (!result) {
            return;
        }
        reportMissing(
            result.manifest.missing,
            assetMap,
            "Partial backup successful, but the following profile images were missing and skipped:\n\n",
            result.discarded,
            result.refused,
        );
    } catch (error) {
        console.error(error);
        alertError(`Backup failed: ${error}`);
    }
}

/** How many missing assets the RisuAI-compatible backup's report lists by name. */
const UPSTREAM_EXPORT_MISSING_SHOWN = 20;

/**
 * The confirmation for `shared/upstreamExportReport.ts`: counts, localized codes with counts/name
 * examples, the first 20 missing assets by owner/role, and discarded/refused flush warnings that the
 * archive holds the server's copy. Ends with "Download it now?"; only yes starts the download.
 */
function upstreamExportReportText(report: UpstreamExportReport, discarded: string[], refused: string[]): string {
    const text = language.upstreamExport;
    const lines: string[] = [text.intro, ""];
    for (const key of Object.keys(text.counts) as (keyof UpstreamExportCounts)[]) {
        lines.push(`${text.counts[key]}: ${report.counts[key]}`);
    }
    const entries = (
        title: string,
        list: UpstreamExportReport["converted"] | UpstreamExportReport["excluded"],
        labels: Record<string, string>,
    ) => {
        if (list.length === 0) {
            return;
        }
        lines.push("", title);
        for (const entry of list) {
            const examples =
                entry.examples.length > 0 ? ` (${language.upstreamImport.examples} ${entry.examples.join(", ")})` : "";
            lines.push(`- ${labels[entry.code] ?? entry.code}: ${entry.count}${examples}`);
        }
    };
    entries(text.convertedTitle, report.converted, text.converted);
    entries(text.excludedTitle, report.excluded, text.excluded);
    if (report.missing.length > 0) {
        lines.push("", text.missingTitle);
        for (const asset of report.missing.slice(0, UPSTREAM_EXPORT_MISSING_SHOWN)) {
            const owner = asset.owner || language.upstreamImport.settingOwner;
            lines.push(`- ${owner}: ${language.upstreamImport.roles[asset.role] ?? asset.role} (${asset.key})`);
        }
        if (report.missing.length > UPSTREAM_EXPORT_MISSING_SHOWN) {
            lines.push(language.upstreamImport.missingMore(report.missing.length - UPSTREAM_EXPORT_MISSING_SHOWN));
        }
    }
    if (discarded.length > 0) {
        lines.push("", language.backupDiscardedChanges);
    }
    if (refused.length > 0) {
        lines.push("", backupRefusedNote(refused));
    }
    lines.push("", text.downloadQuestion);
    return lines.join("\n");
}

/** The file name (without `.bin`) of a RisuAI-compatible backup made at `date`: `RisuAI-backup-YYYY-MM-DD`, local time. */
export function upstreamBackupFileName(date: Date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `RisuAI-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A RisuAI-compatible backup: a `.bin` upstream RisuAI's "Load Backup" restores. Asks whether to
 * include the API keys (every key, the auxiliary services', the characters' TTS keys, and the MCP
 * OAuth secrets included; No is recommended). A failed flush stops preparation; discarded/refused
 * edits appear as warnings. The server prepares one copy of the store with this tab's selection
 * and open chat (`src/ts/drive/upstreamBackupClient.ts`). A yes to the report streams the download
 * to `RisuAI-backup-<date>.bin`; a declined report cancels the prepared export. The file carries no
 * manifest; nothing is read from the stream.
 */
export async function SaveUpstreamLocalBackup() {
    const includeSecrets = await alertConfirm(language.upstreamExport.includeKeys);
    alertWait(language.upstreamExport.preparing);
    let discarded: string[];
    let refused: string[];
    try {
        ({ discarded, refused } = await flushResources());
    } catch (error) {
        alertError(`Could not save your latest changes before the backup: ${error}`);
        return;
    }
    // Loaded only for this path, as the upstream import is.
    const client = await import("./upstreamBackupClient");
    /** The alert text for a refusal (the server's reason) or another failure. */
    const failureText = (error: unknown) =>
        error instanceof client.UpstreamExportRequestError
            ? (error.serverError ?? language.upstreamExport.requestFailed(error.status))
            : `Backup failed: ${error instanceof Error ? error.message : String(error)}`;
    let prepared: Awaited<ReturnType<typeof client.prepareUpstreamExport>>;
    try {
        prepared = await client.prepareUpstreamExport(client.tabExportRequest(includeSecrets));
    } catch (error) {
        console.error(error);
        alertError(failureText(error));
        return;
    }
    if (!(await alertConfirm(upstreamExportReportText(prepared.report, discarded, refused)))) {
        void client.cancelUpstreamExport(prepared.token);
        return;
    }
    try {
        alertWait(`${language.upstreamExport.downloading}...`);
        const response = await client.downloadUpstreamExport(prepared.token);
        if (!(await streamToFile(response, language.upstreamExport.downloading, upstreamBackupFileName()))) {
            return;
        }
    } catch (error) {
        console.error(error);
        alertError(failureText(error));
        return;
    }
    alertNormal(language.upstreamExport.success);
}

/**
 * Restores a local backup archive through the server: it replaces every resource, adds the archive's
 * assets that are missing (existing files are kept), then the app reloads. An archive whose first
 * record is not `manifest.json` goes to the upstream RisuAI import, which shows its report first.
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

            if ((await readFirstRecordName(file)) !== "manifest.json") {
                // Loaded only for this path (it brings the selection and report modules).
                const { restoreUpstreamBackup } = await import("./upstreamBackupClient");
                await restoreUpstreamBackup(file);
                return;
            }
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
