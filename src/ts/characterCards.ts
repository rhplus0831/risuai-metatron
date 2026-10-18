import { settings } from "./storage/settingsViews.svelte";
import { writable, type Writable } from "svelte/store";
import { alertCardExport, alertConfirm, alertError, alertInput, alertNormal, alertStore, alertWait } from "./alert";
import {
    defaultSdDataFunc,
    type character,
    type customscript,
    type loreSettings,
    type loreBook,
    type triggerscript,
    type groupChat,
    appVer,
} from "./storage/database.svelte";
import { importPreset } from "./storage/presets.svelte";
import { checkNullish, decryptBuffer, isKnownUri, selectFileByDom, sleep } from "./util";
import { language } from "src/lang";
import { v4 as uuidv4, v4 } from "uuid";
import { changeChar } from "./characters";
import {
    AppendableBuffer,
    BlankWriter,
    checkCharOrder,
    downloadFile,
    LocalWriter,
    readImage,
    saveAsset,
    VirtualWriter,
} from "./globalApi.svelte";
import { compressImage, getImageType } from "./media";
import { PROMPT_SETTINGS_MENU, SettingsMenuIndex, settingsOpen } from "./stores.svelte";
import {
    addCharacter,
    type AnyClientCharacter,
    characterSnapshot,
    type ClientCharacter,
} from "./storage/characterStore.svelte";
import { addModule, incrementStatic } from "./storage/collectionStore.svelte";
import { hasher } from "./parser/parser.svelte";
import { type CharacterCardV3, type LorebookEntry } from "@risuai/ccardlib";
import { reencodeImage } from "./process/files/inlays";
import { PngChunk } from "./pngChunk";
import type { OnnxModelFiles } from "./process/transformers";
import { CharXImporter, CharXWriter } from "./process/processzip";
import {
    exportModuleLegacy,
    importModuleFile,
    prepareModuleImport,
    readModule,
    type RisuModule,
    serverImportErrorMessage,
} from "./process/modules";
import { loadAssetsInBatches, saveAssets, type AssetSaveItem } from "./storage/assetQueue";
import { importCharxOverServer } from "./storage/charxImportClient";
import { importRealmOverServer } from "./storage/realmImportClient";
import { ServerImportRequestError } from "./storage/serverImportClient";
import { type CharxImportResult, INVALID_CHARX_FILE } from "../../shared/charxImport.ts";
import { REALM_DOWNLOAD_FAILED, type RealmImportResult } from "../../shared/realmImport.ts";

export const hubURL = "/hub-proxy";

export async function importCharacter() {
    // The id of the last character this call imported (none: null), kept when a later file fails.
    let lastImported: string | null = null;
    try {
        const files = await selectFileByDom(["*"], "multiple");
        if (!files) {
            return;
        }

        for (const f of files) {
            lastImported =
                (await importCharacterProcess({
                    name: f.name,
                    data: f,
                })) ?? lastImported;
            checkCharOrder();
        }
        return lastImported;
    } catch (error) {
        alertError(error);
        return lastImported;
    }
}

/**
 * Imports one card file, dispatched by its name (`.json`, `.charx`/`.jpg`/`.jpeg`, `.png`). A CharX
 * (or a `charxJpeg`) given as a `File` or `Blob` is uploaded as it is to the server's CharX import
 * (`importCharxOverServer`, large-asset-import slice 2d), so the tab never holds the file; one given
 * as bytes or a stream is read by the in-tab `CharXImporter`. Every input is told apart without
 * `instanceof Blob`: a `Uint8Array` or a `ReadableStream` is read in the tab, anything else is a
 * `Blob` (a test's `Response.blob()` is not the environment's `Blob`). The PNG reader
 * (`PngChunk.readGenerator`) takes bytes, a stream, or a `Blob`, which it streams: a stream is read
 * once (a running asset count), bytes or a `Blob` are counted in a first pass. Returns the new
 * character's id (with `returnCharacter`, the character), or null/undefined once the failure is
 * alerted.
 */
export async function importCharacterProcess<T extends boolean = false>(f: {
    name: string;
    data: Uint8Array | Blob | ReadableStream<Uint8Array>;
    returnCharacter?: T; //note That this option only works with v3 charx
}): Promise<T extends true ? character | string | null : string | null> {
    if (f.name.endsWith("json")) {
        if (f.data instanceof ReadableStream) {
            return null;
        }
        const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(await f.data.arrayBuffer());
        const da = JSON.parse(Buffer.from(data).toString("utf-8"));
        const imported = await importCharacterCardSpec(da);
        if (imported) {
            return imported as any;
        }
        if ((da.char_name || da.name) && (da.char_persona || da.description) && (da.char_greeting || da.first_mes)) {
            const chaId = addCharacter(convertOffSpecCards(da));
            alertNormal(language.importedCharacter);
            return chaId as any;
        } else {
            alertError(language.errors.noData);
            return;
        }
    }
    incrementStatic("imports");

    if (f.name.endsWith("charx") || f.name.endsWith("jpg") || f.name.endsWith("jpeg")) {
        // The in-tab reader for bytes and streams (tests); a `File`/`Blob` goes to the server.
        let importer: CharXImporter | null = null;
        let cardData: string | null | undefined;
        let moduleData: Buffer | null = null;
        let assets: { [key: string]: string } = {};
        if (f.data instanceof Uint8Array || f.data instanceof ReadableStream) {
            console.log("reading charx");
            alertStore.set({
                type: "wait",
                msg: "Loading... (Reading)",
            });
            importer = new CharXImporter();
            importer.alertInfo = true;
            await importer.parse(f.data);
            cardData = importer.cardData;
            moduleData = importer.moduleData ? Buffer.from(importer.moduleData) : null;
        } else {
            alertWait(language.charxImportUploading);
            let stored: CharxImportResult;
            try {
                stored = await importCharxOverServer(f.data, {
                    onProgress: (done, total) => {
                        alertWait(`Loading... (Saving Assets ${done}/${total})`);
                    },
                });
            } catch (error) {
                // Each alert replaces the wait alert; nothing clears the store after it.
                alertError(charxImportErrorMessage(error));
                return null;
            }
            cardData = stored.card;
            // The embedded module only (small): the file itself never reaches the tab.
            moduleData = stored.moduleData === null ? null : Buffer.from(stored.moduleData, "base64");
            assets = stored.assets;
        }
        const readAssets = async () => {
            if (importer) {
                await importer.done();
                return importer.assets;
            }
            return assets;
        };
        return (await importCharxCard(cardData, moduleData, readAssets, f.returnCharacter)) as any;
    }

    if (!f.name.endsWith("png")) {
        alertError(language.errors.noData);
        return;
    }
    alertStore.set({
        type: "wait",
        msg: "Loading... (Reading)",
    });
    await sleep(10);

    // const readed = PngChunk.read(img, ['chara'])?.['chara']
    let readedChara = "";
    let readedCCv3 = "";
    let img: Uint8Array;
    let pngChunks = 0;
    let readedPngChunks = 0;

    // A stream is read once, so its asset progress is a running count (`pngChunks` stays 0). Bytes or a
    // `Blob` (streamed again by `PngChunk.readGenerator`, never read into bytes) can be read twice: a first
    // pass counts the asset chunks for the percentage.
    if (!(f.data instanceof ReadableStream)) {
        for await (const chunk of PngChunk.readGenerator(f.data, {})) {
            if (chunk instanceof AppendableBuffer) {
                break;
            }
            if (chunk.key.startsWith("chara-ext-asset_")) {
                pngChunks++;
            }
        }
    }

    const readGenerator = PngChunk.readGenerator(f.data, {
        returnTrimed: true,
    });
    const assets: { [key: string]: string } = {};
    // The asset chunks feed the save queue as they are read: the queue pulls the next chunk only when
    // a slot is free, and each chunk's base64 is decoded inside its item's `load()`.
    const assetIndices: string[] = [];
    const showAssetProgress = () => {
        if (pngChunks === 0) {
            alertWait("Loading... (Loaded " + readedPngChunks + " Assets)");
        } else {
            alertStore.set({
                type: "progress",
                msg: "Loading... (Loading Assets)",
                submsg: ((readedPngChunks / pngChunks) * 100).toFixed(2),
            });
        }
    };
    async function* assetChunks(): AsyncGenerator<AssetSaveItem> {
        for await (const chunk of readGenerator) {
            if (!chunk) {
                continue;
            }
            if (chunk instanceof AppendableBuffer) {
                img = chunk.buffer;
                break;
            }
            if (chunk.key === "chara") {
                //For memory reason, limit to 5MB
                if (readedChara.length < 5 * 1024 * 1024) {
                    readedChara = chunk.value;
                }
                continue;
            }
            if (chunk.key === "ccv3") {
                if (readedCCv3.length < 5 * 1024 * 1024) {
                    readedCCv3 = chunk.value;
                }
                continue;
            }
            if (chunk.key.startsWith("chara-ext-asset_")) {
                const assetIndex = chunk.key.replace("chara-ext-asset_:", "").replace("chara-ext-asset_", "");
                const value = chunk.value;
                if (assetIndices.length === 0) {
                    showAssetProgress();
                }
                assetIndices.push(assetIndex);
                yield { load: () => Buffer.from(value, "base64") };
            }
        }
    }
    const assetIds = await saveAssets(assetChunks(), {
        onProgress: (done) => {
            readedPngChunks = done;
            showAssetProgress();
        },
    });
    assetIds.forEach((assetId, i) => {
        assets[assetIndices[i]] = assetId;
    });

    if (!readedChara && !readedCCv3) {
        alertError(language.errors.noData);
        return;
    }

    if (readedCCv3) {
        readedChara = readedCCv3;
    }

    if (!img) {
        alertError(language.errors.noData);
        return;
    }

    return (await importPngCard(readedChara, img, assets)) as any;
}

/**
 * Builds the character of a CharX file from its read parts, the in-tab `CharXImporter`'s or the
 * server's (`importCharxOverServer`, the Realm download): the card's text, the embedded module's
 * bytes, and `readAssets`, which answers each asset entry's stored key (read only once the card and
 * the module are read). Returns the new character's id (with `returnCharacter`, the character), or
 * null/undefined once the failure is alerted.
 */
async function importCharxCard(
    cardData: string | null | undefined,
    moduleData: Buffer | null,
    readAssets: () => Promise<{ [key: string]: string }>,
    returnCharacter?: boolean,
): Promise<character | string | false | null | undefined> {
    if (!cardData) {
        alertError(language.errors.noData);
        return;
    }
    const card: CharacterCardV3 = JSON.parse(cardData);
    if (card.spec !== "chara_card_v3") {
        alertError(language.errors.noData);
        return;
    }
    let lorebook: loreBook[] = null;
    if (moduleData) {
        const md = await readModule(moduleData);
        card.data.extensions ??= {};
        card.data.extensions.risuai ??= {};
        card.data.extensions.risuai.triggerscript = md.trigger ?? [];
        card.data.extensions.risuai.customScripts = md.regex ?? [];
        if (md.lorebook) {
            lorebook = md.lorebook;
        }
    }
    const assets = await readAssets();
    const v = await importCharacterCardSpec(card, undefined, "normal", assets, lorebook, returnCharacter);
    if (returnCharacter) {
        return v;
    }
    return v || null;
}

/**
 * Builds the character of a PNG card from its read parts, the in-tab reader's or the server's (the
 * Realm download): the card chunk's text (`ccv3`, else `chara`: base64 JSON, or an `rcc||` card), the
 * image without its text chunks (bytes, or the key the server stored it under), and each asset
 * chunk's stored key by index. Returns the new character's id, or null/undefined once the failure is
 * alerted.
 */
async function importPngCard(
    readedChara: string,
    img: Uint8Array | string,
    assets: { [key: string]: string },
): Promise<string | false | null | undefined> {
    if (readedChara.startsWith("rcc||")) {
        const parts = readedChara.split("||");
        const type = parts[1];
        if (type === "rccv1") {
            if (parts.length !== 5) {
                alertError(language.errors.noData);
                return;
            }
            const encrypted = Buffer.from(parts[2], "base64");
            const hashed = await hasher(encrypted);
            if (hashed !== parts[3]) {
                alertError(language.errors.noData);
                return;
            }
            const metaData: RccCardMetaData = JSON.parse(Buffer.from(parts[4], "base64").toString("utf-8"));
            if (metaData.usePassword) {
                const password = await alertInput(language.inputCardPassword);
                if (!password) {
                    return;
                } else {
                    try {
                        const decrypted = await decryptBuffer(encrypted, password);
                        const charaData: CharacterCardV2Risu = JSON.parse(Buffer.from(decrypted).toString("utf-8"));
                        const imported = await importCharacterCardSpec(charaData, img, "normal", assets);
                        if (imported) {
                            return imported;
                        } else {
                            throw new Error("Error while importing");
                        }
                    } catch (error) {
                        alertError(language.errors.wrongPassword);
                        return;
                    }
                }
            } else {
                const decrypted = await decryptBuffer(encrypted, "RISU_NONE");
                try {
                    const charaData: CharacterCardV2Risu = JSON.parse(Buffer.from(decrypted).toString("utf-8"));
                    const imported = await importCharacterCardSpec(charaData, img, "normal", assets);
                    if (imported) {
                        return imported;
                    }
                } catch (error) {
                    alertError(language.errors.noData);
                    return;
                }
            }
        }
    }
    const parsed = JSON.parse(Buffer.from(readedChara, "base64").toString("utf-8"));
    //fix readedChara version pointing number instead of string because of previous version
    if (typeof (parsed as CharacterCardV2Risu)?.data?.character_version === "number") {
        (parsed as CharacterCardV2Risu).data.character_version = (
            parsed as CharacterCardV2Risu
        ).data.character_version.toString();
    }

    if (parsed.spec !== "chara_card_v2" && parsed.spec !== "chara_card_v3") {
        const charaData: OldTavernChar = JSON.parse(Buffer.from(readedChara, "base64").toString("utf-8"));
        const imgp = typeof img === "string" ? img : await saveAsset(img);
        const chaId = addCharacter(convertOffSpecCards(charaData, imgp));
        alertNormal(language.importedCharacter);
        return chaId;
    }
    return (await importCharacterCardSpec(parsed, img, "normal", assets)) || null;
}

/** The alert for a CharX upload that failed (slice 2d); `Invalid character file` is `noData`. */
function charxImportErrorMessage(error: unknown): string {
    return serverImportErrorMessage(error, {
        invalidFile: INVALID_CHARX_FILE,
        fileTooLarge: language.charxImportFileTooLarge,
        requestFailed: language.charxImportRequestFailed,
        stopped: language.charxImportStopped,
    });
}

/**
 * The alert for a Realm download that failed: a download the server could not make is its own text;
 * a Realm refusal is Realm's text (a 502 with it); `Invalid character file` is `noData`.
 */
function realmImportErrorMessage(error: unknown): string {
    if (
        error instanceof ServerImportRequestError &&
        error.status === 502 &&
        error.serverError === REALM_DOWNLOAD_FAILED
    ) {
        return language.realmImportDownloadFailed;
    }
    return serverImportErrorMessage(error, {
        invalidFile: INVALID_CHARX_FILE,
        fileTooLarge: language.realmImportFileTooLarge,
        requestFailed: language.realmImportRequestFailed,
        stopped: language.realmImportStopped,
        interrupted: language.realmImportInterrupted,
    });
}

export const getRealmInfo = async (realmPath: string) => {
    const url = new URL(location.href);
    url.searchParams.delete("realm");
    // Replaced, not pushed: a consumed link parameter is no history entry (`docs/plan/url-routes.md` R5).
    window.history.replaceState(window.history.state, "", url.toString());

    const res = await fetch(`${hubURL}/hub/info/${realmPath}`);
    if (res.status !== 200) {
        alertError(await res.text());
        return;
    }
    showRealmInfoStore.set(await res.json());
};

export const showRealmInfoStore: Writable<null | hubType> = writable(null);

/**
 * A pending share survives a failed or cancelled import, even without a controlling worker. The
 * importer reads the cached answer itself: a module as its `Blob`, uploaded as it is (large-asset-import
 * slice 2c), a card or a preset as bytes.
 */
async function importPendingShare(
    kind: "character" | "preset" | "module",
    importer: (pending: Response) => Promise<unknown>,
) {
    if (typeof caches === "undefined") {
        return;
    }
    const cache = await caches.open("risuCache");
    const url = new URL(`/sw/share/${kind}`, location.origin);
    const pending = await cache.match(url);
    if (pending && (await importer(pending))) {
        await cache.delete(url);
    }
}

export async function characterURLImport() {
    // Read now: the router (started later in `loadData`) writes URLs without a query or hash.
    const hash = location.hash;
    const realmPath = new URLSearchParams(location.search).get("realm");
    try {
        if (realmPath) {
            getRealmInfo(realmPath);
        }
    } catch (error) {}

    const charPath = new URLSearchParams(location.search).get("charahub");
    try {
        if (charPath) {
            alertWait("Loading from Chub...");
            const url = new URL(location.href);
            url.searchParams.delete("charahub");
            window.history.replaceState(window.history.state, "", url.toString());
            const chara = await fetch("https://api.chub.ai/api/characters/download", {
                method: "POST",
                body: JSON.stringify({
                    format: "tavern",
                    fullPath: charPath,
                    version: "main",
                }),
                headers: {
                    "content-type": "application/json",
                },
            });
            // The response stream itself: the card is read once as it downloads.
            await importCharacterProcess({
                name: "charahub.png",
                data: chara.body,
            });
        }
    } catch (error) {
        alertError(language.errors.noData);
        return null;
    }

    if (hash.startsWith("#import=")) {
        window.history.replaceState(window.history.state, "", location.pathname + location.search);
        const url = hash.replace("#import=", "");
        try {
            const res = await fetch(url, {
                method: "GET",
            });
            await importFile(getFileName(res), await res.blob());
            checkCharOrder();
        } catch (error) {
            alertError(language.errors.noData);
            return null;
        }
    }
    if (hash.startsWith("#import_module=")) {
        const data = hash.replace("#import_module=", "");
        const importData = JSON.parse(Buffer.from(decodeURIComponent(data), "base64").toString("utf-8"));
        importData.id = v4();

        if (importData.lowLevelAccess) {
            const conf = await alertConfirm(language.lowLevelAccessConfirm);
            if (!conf) {
                return false;
            }
        }
        if (!(await prepareModuleImport(importData))) {
            return false;
        }
        addModule(importData);
        alertNormal(language.successImport);
        SettingsMenuIndex.set(14);
        settingsOpen.set(true);
        return;
    }
    if (hash.startsWith("#import_preset=")) {
        const data = hash.replace("#import_preset=", "");
        const importData = Buffer.from(decodeURIComponent(data), "base64");
        await importPreset({
            name: "imported.risupreset",
            data: importData,
        });
        SettingsMenuIndex.set(PROMPT_SETTINGS_MENU);
        settingsOpen.set(true);
        return;
    }
    if (hash.startsWith("#share_character")) {
        // The cached answer's `Blob`, uploaded as it is (large-asset-import slice 2d).
        await importPendingShare("character", async (pending) =>
            importCharacterProcess({ name: "shared.charx", data: await pending.blob() }),
        );
    }
    if (hash.startsWith("#share_module")) {
        await importPendingShare("module", async (pending) => {
            // Prepared under a fresh id; null when declined or failed (alerted).
            const md = await importModuleFile(await pending.blob());
            if (!md) {
                return false;
            }
            const id = addModule(md);
            alertNormal(language.successImport);
            SettingsMenuIndex.set(14);
            settingsOpen.set(true);
            return id;
        });
    }
    if (hash.startsWith("#share_preset")) {
        await importPendingShare("preset", async (pending) => {
            const id = await importPreset({ name: "shared.risup", data: new Uint8Array(await pending.arrayBuffer()) });
            if (id) {
                SettingsMenuIndex.set(PROMPT_SETTINGS_MENU);
                settingsOpen.set(true);
            }
            return id;
        });
    }
    if ("launchQueue" in window) {
        const handleFiles = async (files: FileSystemFileHandle[]) => {
            for (const f of files) {
                await importFile(f.name, await f.getFile());
            }
        };
        //@ts-expect-error launchQueue is File Handling API for PWA, not yet in TypeScript's Window interface
        window.launchQueue.setConsumer((launchParams) => {
            if (launchParams.files && launchParams.files.length) {
                const files = launchParams.files as FileSystemFileHandle[];
                handleFiles(files);
            }
        });
    }

    /**
     * A `.risum` (slice 2c) and a CharX (`.charx`, a `charxJpeg`'s `.jpg`/`.jpeg`; slice 2d) go to the
     * server as the `Blob` itself, and a `.png` card goes to the PNG reader as the `Blob` itself, which
     * streams it (slice 2e). Only a preset is read into bytes: `importPreset` decompresses it in memory.
     */
    async function importFile(name: string, data: Blob) {
        if (name.endsWith(".charx") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png")) {
            await importCharacterProcess({ name: name, data: data });
            return;
        }
        if (name.endsWith(".risupreset") || name.endsWith(".risup")) {
            await importPreset({
                name: name,
                data: new Uint8Array(await data.arrayBuffer()),
            });
            SettingsMenuIndex.set(PROMPT_SETTINGS_MENU);
            settingsOpen.set(true);
            alertNormal(language.successImport);
            return;
        }
        if (name.endsWith("risum")) {
            const md = await importModuleFile(data);
            if (!md) {
                return;
            }
            addModule(md);
            alertNormal(language.successImport);
            SettingsMenuIndex.set(14);
            settingsOpen.set(true);
            return;
        }
    }

    function getFileName(res: Response): string {
        return getFromContent(res.headers.get("content-disposition")) || getFromURL(res.url);

        function getFromContent(contentDisposition: string) {
            if (!contentDisposition) return null;
            const pattern = /filename\*=UTF-8''([^"';\n]+)|filename[^;\n=]*=["']?([^"';\n]+)["']?/;
            const matches = contentDisposition.match(pattern);
            if (matches) {
                if (matches[1]) {
                    return decodeURIComponent(matches[1]);
                } else if (matches[2]) {
                    return matches[2];
                }
            }
            return null;
        }

        function getFromURL(url: string): string {
            try {
                const path = new URL(url).pathname;
                return path.substring(path.lastIndexOf("/") + 1);
            } catch {
                return "";
            }
        }
    }
}

function convertOffSpecCards(
    charaData: OldTavernChar | CharacterCardV2Risu,
    imgp: string | undefined = undefined,
): character {
    const data = charaData.spec_version === "2.0" ? charaData.data : charaData;
    const charbook = charaData.spec_version === "2.0" ? charaData.data.character_book : null;
    let lorebook: loreBook[] = [];
    let loresettings: undefined | loreSettings = undefined;
    let loreExt: undefined | any = undefined;
    if (charbook) {
        const a = convertCharbook({
            lorebook,
            charbook,
            loresettings,
            loreExt,
        });

        lorebook = a.lorebook;
        loresettings = a.loresettings;
        loreExt = a.loreExt;
    }

    return {
        name: data.name ?? "unknown name",
        firstMessage: data.first_mes ?? "unknown first message",
        desc: data.description ?? "",
        notes: "",
        chats: [
            {
                id: uuidv4(),
                message: [],
                note: "",
                name: "Chat 1",
                localLore: [],
            },
        ],
        chatPage: 0,
        image: imgp,
        emotionImages: [],
        bias: [],
        globalLore: lorebook,
        viewScreen: "none",
        chaId: uuidv4(),
        sdData: defaultSdDataFunc(),
        utilityBot: false,
        customscript: [],
        exampleMessage: data.mes_example,
        creatorNotes: "",
        systemPrompt: (charaData.spec_version === "2.0" ? charaData.data.system_prompt : "") ?? "",
        postHistoryInstructions:
            (charaData.spec_version === "2.0" ? charaData.data.post_history_instructions : "") ?? "",
        alternateGreetings: [],
        tags: [],
        creator: "",
        characterVersion: "",
        personality: data.personality ?? "",
        scenario: data.scenario ?? "",
        firstMsgIndex: -1,
        replaceGlobalNote: "",
        triggerscript: [],
        additionalText: "",
        loreExt: loreExt,
        loreSettings: loresettings,
        chatFolders: [],
    };
}

export async function exportChar(chaId: string): Promise<string> {
    let char = characterSnapshot(chaId);
    if (!char) {
        return "";
    }

    if (char.type === "group") {
        return "";
    }

    if (!char.image) {
        const res = await fetch("/none.webp");
        const data = new Uint8Array(await res.arrayBuffer());
        char.image = await saveAsset(data);
    }

    const option = await alertCardExport();
    if (option.type === "") {
        exportCharacterCard(
            char,
            option.type2 === "json"
                ? "json"
                : option.type2 === "charx"
                  ? "charx"
                  : option.type2 === "charxJpeg"
                    ? "charxJpeg"
                    : "png",
            { spec: "v3" },
        );
    } else if (option.type === "ccv2") {
        exportCharacterCard(char, "png", { spec: "v2" });
    } else {
        return option.type;
    }
    return "";
}

/**
 * Saves a card's embedded assets (v2 `emotions`, `additionalAssets`, `vits`) through the save queue
 * and returns each entry's asset path in order: an `__asset:<key>` reference resolves through
 * `assetDict` (a missing key throws before anything is saved); any other value is base64 (`normal`)
 * or a hub resource id (`hub`, fetched inside the item's `load()`). The progress alert shows `msg`
 * with the share of saved entries.
 */
async function saveEmbeddedAssets(
    entries: { value: string; fileName?: string }[],
    assetDict: { [key: string]: string },
    mode: "hub" | "normal",
    msg: string,
): Promise<string[]> {
    const paths: string[] = [];
    const pending: number[] = [];
    const items: AssetSaveItem[] = [];
    for (let i = 0; i < entries.length; i++) {
        const { value, fileName } = entries[i];
        if (value.startsWith("__asset:")) {
            const key = value.replace("__asset:", "");
            const imgp = assetDict[key];
            if (!imgp) {
                throw new Error("Error while importing, asset " + key + " not found");
            }
            paths[i] = imgp;
            continue;
        }
        pending.push(i);
        items.push({
            load: () => (mode === "hub" ? getHubResources(value) : Buffer.from(value, "base64")),
            fileName: fileName || undefined,
        });
    }
    const showProgress = (done: number) => {
        alertStore.set({
            type: "progress",
            msg,
            submsg: (items.length === 0 ? 100 : (done / items.length) * 100).toFixed(2),
        });
    };
    if (entries.length > 0) {
        showProgress(0);
    }
    const saved = await saveAssets(items, { onProgress: showProgress });
    pending.forEach((entry, i) => {
        paths[entry] = saved[i];
    });
    return paths;
}

async function importCharacterCardSpec<T extends boolean = false>(
    card: CharacterCardV2Risu | CharacterCardV3,
    img?: Uint8Array | string,
    mode: "hub" | "normal" = "normal",
    assetDict: { [key: string]: string } = {},
    overrideLorebook: loreBook[] = null,
    returnValue: T = false as T,
): Promise<T extends true ? character | false : string | false> {
    if (!card || (card.spec !== "chara_card_v2" && card.spec !== "chara_card_v3")) {
        return false;
    }

    console.log(`Importing ${card.spec}, mode is ${mode}`);

    const data = card.data;
    // A string is the key the server already stored the image under (the Realm download).
    let im = typeof img === "string" ? img : img ? await saveAsset(img) : undefined;
    const risuext = safeStructuredClone(data.extensions.risuai);
    let emotions: [string, string][] = [];
    let bias: [string, number][] = [];
    let viewScreen: "none" | "emotion" | "imggen" = "none";
    let customScripts: customscript[] = [];
    let utilityBot = false;
    let sdData = defaultSdDataFunc();
    let extAssets: [string, string, string][] = [];
    let ccAssets: {
        type: string;
        uri: string;
        name: string;
        ext: string;
    }[] = [];

    let vits: null | OnnxModelFiles = null;
    if (risuext && card.spec === "chara_card_v2") {
        if (risuext.emotions) {
            const paths = await saveEmbeddedAssets(
                risuext.emotions.map((emotion) => ({ value: emotion[1] })),
                assetDict,
                mode,
                "Loading... (Loading Emotions)",
            );
            for (let i = 0; i < risuext.emotions.length; i++) {
                emotions.push([risuext.emotions[i][0], paths[i]]);
            }
        }
        if (risuext.additionalAssets) {
            const fileNames = risuext.additionalAssets.map((asset) => (asset.length >= 3 ? asset[2] : ""));
            const paths = await saveEmbeddedAssets(
                risuext.additionalAssets.map((asset, i) => ({ value: asset[1], fileName: fileNames[i] })),
                assetDict,
                mode,
                "Loading... (Loading Assets)",
            );
            for (let i = 0; i < risuext.additionalAssets.length; i++) {
                extAssets.push([risuext.additionalAssets[i][0], paths[i], fileNames[i]]);
            }
        }
        if (risuext.vits) {
            const keys = Object.keys(risuext.vits);
            const paths = await saveEmbeddedAssets(
                keys.map((key) => ({ value: risuext.vits[key] })),
                assetDict,
                mode,
                "Loading... (Loading VITS)",
            );
            for (let i = 0; i < keys.length; i++) {
                risuext.vits[keys[i]] = paths[i];
            }

            if (keys.length > 0) {
                vits = {
                    name: "Imported VITS",
                    files: risuext.vits,
                    id: uuidv4().replace(/-/g, ""),
                };
            }
        }

        if (risuext) {
            bias = risuext.bias ?? bias;
            viewScreen = risuext.viewScreen ?? viewScreen;
            customScripts = risuext.customScripts ?? customScripts;
            utilityBot = risuext.utilityBot ?? utilityBot;
            sdData = risuext.sdData ?? sdData;
        }
    }
    if (card.spec === "chara_card_v3") {
        const data = card.data; //required for type checking
        if (data.assets) {
            // First pass: resolve the referenced keys and queue the `data:` URIs; the second pass
            // (after the saves) builds the records in card order, `ccdefault:` reading `im` as it is
            // at that entry (a preceding `icon`/`main` entry replaces it).
            type Source = { kind: "key"; path: string } | { kind: "ccdefault" } | { kind: "saved"; item: number };
            const sources: (Source | null)[] = [];
            const items: AssetSaveItem[] = [];
            for (let i = 0; i < data.assets.length; i++) {
                const uri = data.assets[i].uri;
                if (uri.startsWith("__asset:") || uri.startsWith("embeded://")) {
                    const key = uri.startsWith("__asset:")
                        ? uri.replace("__asset:", "")
                        : uri.replace("embeded://", "");
                    const path = assetDict[key];
                    if (!path) {
                        throw new Error("Error while importing, asset " + key + " not found");
                    }
                    sources.push({ kind: "key", path });
                } else if (uri === "ccdefault:") {
                    sources.push({ kind: "ccdefault" });
                } else if (uri.startsWith("data:")) {
                    //data uri
                    const b64 = uri.split(",")[1];
                    if (b64.length < 50 * 1024 * 1024) {
                        sources.push({ kind: "saved", item: items.length });
                        items.push({ load: () => Buffer.from(b64, "base64") });
                    } else {
                        alertError("Data URI too large");
                        sources.push(null);
                    }
                } else {
                    sources.push(null);
                }
            }
            const showProgress = (done: number) => {
                alertStore.set({
                    type: "progress",
                    msg: `Loading... (Assets)`,
                    submsg: (items.length === 0 ? 100 : (done / items.length) * 100).toFixed(2),
                });
            };
            if (data.assets.length > 0) {
                showProgress(0);
            }
            const saved = await saveAssets(items, { onProgress: showProgress });
            for (let i = 0; i < data.assets.length; i++) {
                const source = sources[i];
                if (!source) {
                    continue;
                }
                let fileName = "";
                if (data.assets[i].name) {
                    fileName = data.assets[i].name;
                }
                const imgp =
                    source.kind === "key" ? source.path : source.kind === "ccdefault" ? im : saved[source.item];
                if (data.assets[i].type === "emotion") {
                    emotions.push([fileName, imgp]);
                } else if (data.assets[i].type === "x-risu-asset") {
                    extAssets.push([fileName, imgp, data.assets[i].ext ?? "unknown"]);
                } else if (data.assets[i].type === "icon" && data.assets[i].name === "main") {
                    im = imgp;
                } else {
                    ccAssets.push({
                        type: data.assets[i].type ?? "asset",
                        uri: imgp,
                        name: fileName,
                        ext: data.assets[i].ext ?? "unknown",
                    });
                }
            }
        }

        if (risuext) {
            bias = risuext.bias ?? bias;
            viewScreen = risuext.viewScreen ?? viewScreen;
            customScripts = risuext.customScripts ?? customScripts;
            utilityBot = risuext.utilityBot ?? utilityBot;
            sdData = risuext.sdData ?? sdData;
        }
    }

    if (risuext && risuext?.lowLevelAccess) {
        const conf = await alertConfirm(language.lowLevelAccessConfirm);
        if (!conf) {
            return false;
        }
    }
    const charbook = data.character_book;
    let lorebook: loreBook[] = overrideLorebook ?? [];
    let loresettings: undefined | loreSettings = undefined;
    let loreExt: undefined | any = undefined;
    if (charbook) {
        const a = convertCharbook({
            lorebook: overrideLorebook ? [] : lorebook,
            charbook,
            loresettings,
            loreExt,
        });

        if (!overrideLorebook) {
            lorebook = a.lorebook;
        }
        loresettings = a.loresettings;
        loreExt = a.loreExt;
    }

    let ext = safeStructuredClone(data?.extensions ?? {});

    for (const key in ext) {
        if (key === "risuai") {
            delete ext[key];
        }
        if (key === "depth_prompt") {
            delete ext[key];
        }
    }

    let char: character = {
        name: data.name ?? "",
        firstMessage: data.first_mes ?? "",
        desc: data.description ?? "",
        notes: "",
        chats: [
            {
                id: uuidv4(),
                message: [],
                note: "",
                name: "Chat 1",
                localLore: [],
            },
        ],
        chatPage: 0,
        image: im,
        emotionImages: emotions,
        bias: bias,
        globalLore: lorebook, //lorebook
        viewScreen: viewScreen,
        chaId: uuidv4(),
        sdData: sdData,
        utilityBot: utilityBot,
        customscript: customScripts,
        exampleMessage: data.mes_example ?? "",
        creatorNotes: data.creator_notes ?? "",
        systemPrompt: data.system_prompt ?? "",
        postHistoryInstructions: "",
        alternateGreetings: data.alternate_greetings ?? [],
        tags: data.tags ?? [],
        creator: data.creator ?? "",
        characterVersion: `${data.character_version}` || "",
        personality: data.personality ?? "",
        scenario: data.scenario ?? "",
        firstMsgIndex: -1,
        removedQuotes: false,
        loreSettings: loresettings,
        loreExt: loreExt,
        additionalData: {
            tag: data.tags ?? [],
            creator: data.creator,
            character_version: data.character_version,
        },
        additionalAssets: extAssets,
        replaceGlobalNote: data.post_history_instructions ?? "",
        backgroundHTML: data?.extensions?.risuai?.backgroundHTML,
        license: data?.extensions?.risuai?.license,
        triggerscript: data?.extensions?.risuai?.triggerscript ?? [],
        private: data?.extensions?.risuai?.private ?? false,
        additionalText: data?.extensions?.risuai?.additionalText ?? "",
        extentions: ext ?? {},
        largePortrait: data?.extensions?.risuai?.largePortrait ?? !data?.extensions?.risuai,
        lorePlus: data?.extensions?.risuai?.lorePlus ?? false,
        inlayViewScreen: data?.extensions?.risuai?.inlayViewScreen ?? false,
        newGenData: data?.extensions?.risuai?.newGenData ?? undefined,
        vits: vits,
        ttsMode: vits ? "vits" : "normal",
        imported: true,
        source: card?.data?.extensions?.risuai?.source ?? [],
        ccAssets: ccAssets,
        lowLevelAccess: risuext?.lowLevelAccess ?? false,
        defaultVariables: data?.extensions?.risuai?.defaultVariables ?? "",
        chatFolders: [],
        prebuiltAssetCommand: data?.extensions?.risuai?.prebuiltAssetCommand ?? "",
        prebuiltAssetExclude: data?.extensions?.risuai?.prebuiltAssetExclude ?? [],
        prebuiltAssetStyle: data?.extensions?.risuai?.prebuiltAssetStyle ?? "",
        customModuleToggle: data?.extensions?.risuai?.toggles ?? {},
        moduleNamespace: data?.extensions?.risuai?.moduleNamespace,
        hideChatIcon: data?.extensions?.risuai?.hideChatIcon ?? false,
    };

    const depthPrompt = data.extensions?.depth_prompt;
    if (
        depthPrompt !== null &&
        typeof depthPrompt === "object" &&
        !Array.isArray(depthPrompt) &&
        typeof depthPrompt.depth === "number" &&
        Number.isFinite(depthPrompt.depth) &&
        typeof depthPrompt.prompt === "string"
    ) {
        char.depth_prompt = { depth: depthPrompt.depth, prompt: depthPrompt.prompt };
    }

    if (card.spec === "chara_card_v3") {
        char.group_only_greetings = card.data.group_only_greetings ?? [];
        char.nickname = card.data.nickname ?? "";
        char.source = card.data.source ?? card.data?.extensions?.risuai?.source ?? [];
        char.creation_date = card.data.creation_date ?? 0;
        char.modification_date = card.data.modification_date ?? 0;
    }

    if (returnValue) {
        return char as any;
    }

    const chaId = addCharacter(char);
    alertNormal(language.importedCharacter);
    return chaId as any;
}

function convertCharbook(arg: {
    lorebook: loreBook[];
    charbook: CharacterBook;
    loresettings: loreSettings;
    loreExt: any;
}) {
    let { lorebook, loresettings, loreExt, charbook } = arg;
    if (
        !checkNullish(charbook.recursive_scanning) &&
        !checkNullish(charbook.scan_depth) &&
        !checkNullish(charbook.token_budget)
    ) {
        loresettings = {
            tokenBudget: charbook.token_budget,
            scanDepth: charbook.scan_depth,
            recursiveScanning: charbook.recursive_scanning,
            fullWordMatching: charbook?.extensions?.risu_fullWordMatching ?? false,
        };
    }

    loreExt = charbook.extensions;

    for (const book of charbook.entries) {
        let content = book.content;

        if (book.use_regex && !book.keys?.[0]?.startsWith("/")) {
            book.use_regex = false;
        }

        //extention migration
        const extensions = book.extensions ?? {};

        if (extensions.useProbability && extensions.probability !== undefined && extensions.probability !== 100) {
            content = `@@probability ${extensions.probability}\n` + content;
            delete extensions.useProbability;
            delete extensions.probability;
        }
        if (extensions.position === 4 && typeof extensions.depth === "number" && typeof extensions.role === "number") {
            content =
                `@@depth ${extensions.depth}\n@@role ${["system", "user", "assistant"][extensions.role]}\n` + content;
            delete extensions.position;
            delete extensions.depth;
            delete extensions.role;
        }
        if (typeof extensions.selectiveLogic === "number" && book.secondary_keys && book.secondary_keys.length > 0) {
            switch (extensions.selectiveLogic) {
                case 0: {
                    if (!book.secondary_keys || book.secondary_keys.length === 0) {
                        book.selective = false;
                    }
                    break;
                }
                case 1: {
                    book.selective = false;
                    content = `@@exclude_keys_all ${book.secondary_keys.join(",")}\n` + content;
                    break;
                }
                case 2: {
                    book.selective = false;
                    for (const secKey of book.secondary_keys) {
                        content = `@@exclude_keys ${secKey}\n` + content;
                    }
                    break;
                }
                case 3: {
                    book.selective = false;
                    for (const secKey of book.secondary_keys) {
                        content = `@@additional_keys ${secKey}\n` + content;
                    }
                    break;
                }
            }
        }
        if (typeof extensions.delay === "number" && extensions.delay > 0) {
            content = `@@activate_only_after ${extensions.delay}\n` + content;
            delete extensions.delay;
        }
        if (extensions.match_whole_words === true) {
            content = `@@match_full_word\n` + content;
            delete extensions.match_whole_words;
        }
        if (extensions.match_whole_words === false) {
            content = `@@match_partial_word\n` + content;
            delete extensions.match_whole_words;
        }

        lorebook.push({
            key: book.keys.join(", "),
            secondkey: book.secondary_keys?.join(", ") ?? "",
            insertorder: book.insertion_order,
            comment: book.name ?? book.comment ?? "",
            content: content,
            mode: (book.mode as any) ?? "normal",
            alwaysActive: book.constant ?? false,
            selective: book.selective ?? false,
            extentions: { ...extensions, risu_case_sensitive: book.case_sensitive },
            activationPercent: book.extensions?.risu_activationPercent,
            loreCache: book.extensions?.risu_loreCache ?? null,
            useRegex: book.use_regex ?? false,
            folder: book.folder,
        });
    }

    return {
        lorebook,
        loresettings,
        loreExt,
    };
}

function createBaseV2(char: ClientCharacter) {
    let charBook: charBookEntry[] = [];
    for (const lore of char.globalLore) {
        let ext: {
            risu_case_sensitive?: boolean;
            risu_activationPercent?: number;
            risu_loreCache?: {
                key: string;
                data: string[];
            };
        } = safeStructuredClone(lore.extentions ?? {});

        let caseSensitive = ext.risu_case_sensitive ?? false;
        ext.risu_activationPercent = lore.activationPercent;
        ext.risu_loreCache = lore.loreCache;

        charBook.push({
            keys: lore.key.split(",").map((r) => r.trim()),
            secondary_keys: lore.selective ? lore.secondkey.split(",").map((r) => r.trim()) : undefined,
            content: lore.content,
            extensions: ext,
            enabled: true,
            insertion_order: lore.insertorder,
            constant: lore.alwaysActive,
            selective: lore.selective,
            name: lore.comment,
            comment: lore.comment,
            case_sensitive: caseSensitive,
            mode: lore.mode ?? "normal",
            folder: lore.folder,
        });
    }
    char.loreExt ??= {};

    char.loreExt.risu_fullWordMatching = char.loreSettings?.fullWordMatching ?? false;

    const card: CharacterCardV2Risu = {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
            name: char.name,
            description: char.desc ?? "",
            personality: char.personality ?? "",
            scenario: char.scenario ?? "",
            first_mes: char.firstMessage ?? "",
            mes_example: char.exampleMessage ?? "",
            creator_notes: char.creatorNotes ?? "",
            system_prompt: char.systemPrompt ?? "",
            post_history_instructions: char.replaceGlobalNote ?? "",
            alternate_greetings: char.alternateGreetings ?? [],
            character_book: {
                scan_depth: char.loreSettings?.scanDepth,
                token_budget: char.loreSettings?.tokenBudget,
                recursive_scanning: char.loreSettings?.recursiveScanning,
                extensions: char.loreExt ?? {},
                entries: charBook,
            },
            tags: char.tags ?? [],
            creator: char.additionalData?.creator ?? "",
            character_version: `${char.additionalData?.character_version}` || "",
            extensions: {
                risuai: {
                    // emotions: char.emotionImages,
                    bias: char.bias,
                    viewScreen: char.viewScreen,
                    customScripts: char.customscript,
                    utilityBot: char.utilityBot,
                    sdData: char.sdData,
                    // additionalAssets: char.additionalAssets,
                    backgroundHTML: char.backgroundHTML,
                    license: char.license,
                    triggerscript: char.triggerscript,
                    additionalText: char.additionalText,
                    largePortrait: char.largePortrait,
                    lorePlus: char.lorePlus,
                    inlayViewScreen: char.inlayViewScreen,
                    newGenData: char.newGenData,
                    vits: {},
                },
                depth_prompt: char.depth_prompt,
            },
        },
    };

    if (char.extentions) {
        for (const key in char.extentions) {
            if (key === "risuai" || key === "depth_prompt") {
                continue;
            }
            card.data.extensions[key] = char.extentions[key];
        }
    }
    return card;
}

/**
 * The most asset bytes a JSON card export embeds (large-asset-import slice 3b): past this, the
 * base64 data URIs make a card `JSON.stringify` cannot produce, so the export refuses and points
 * to CharX instead.
 */
export const JSON_EXPORT_ASSET_LIMIT = 64 * 1024 * 1024;

export async function exportCharacterCard(
    char: ClientCharacter,
    type: "png" | "json" | "charx" | "charxJpeg" = "png",
    arg: {
        password?: string;
        writer?: LocalWriter | VirtualWriter;
        spec?: "v2" | "v3";
    } = {},
) {
    const spec: "v2" | "v3" = arg.spec ?? "v2"; //backward compatibility
    const localWriter = arg.writer ?? (type === "json" ? undefined : new LocalWriter());
    const controller = new AbortController();
    let missingAssets = 0;
    let jsonAssetBytes = 0;
    const assetBytes = (key: string, bytes: Uint8Array | null) => {
        if (bytes === null) {
            missingAssets++;
            console.warn("Export asset missing or empty:", key);
            return new Uint8Array(0);
        }
        return bytes;
    };
    const finish = () => {
        if (!arg.writer) {
            alertNormal(
                missingAssets > 0
                    ? language.exportMissingAssets.replace("{count}", String(missingAssets))
                    : language.successExport,
            );
        }
        return { missingAssets };
    };
    try {
        let img = await readImage(char.image);
        if (img === null) throw new Error(language.errors.noData);
        char.image = "";
        img = type === "png" ? await reencodeImage(img) : img;
        if (!arg.writer && type !== "json") {
            const nameExt = {
                png: ["Image File", "png"],
                json: ["JSON File", "json"],
                charx: ["CharX File", "charx"],
                charxJpeg: ["CharX Embeded Jpeg", "jpeg"],
            };
            const ext = nameExt[type];
            await (localWriter as LocalWriter).init(ext[0], [ext[1]]);
        }
        const writer =
            type === "charx" || type === "charxJpeg"
                ? new CharXWriter(localWriter)
                : type === "json"
                  ? new BlankWriter()
                  : new PngChunk.streamWriter(img, localWriter);
        await writer.init();
        if (writer instanceof CharXWriter && type === "charxJpeg") {
            await writer.writeJpeg(img);
        }
        let assetIndex = 0;
        if (spec === "v2") {
            const card = await createBaseV2(char);
            if (card.data.extensions.risuai.emotions && card.data.extensions.risuai.emotions.length > 0) {
                const keys = card.data.extensions.risuai.emotions.map((asset) => asset[1]);
                for await (const { index: i, key, bytes } of loadAssetsInBatches(keys, { signal: controller.signal })) {
                    alertStore.set({
                        type: "progress",
                        msg: "Loading... (Adding Emotions)",
                        submsg: ((i / card.data.extensions.risuai.emotions.length) * 100).toFixed(2),
                    });
                    const rData = assetBytes(key, bytes);
                    const b64encoded = Buffer.from(await compressImage(rData)).toString("base64");
                    assetIndex++;
                    card.data.extensions.risuai.emotions[i][1] = `__asset:${assetIndex}`;
                    await writer.write("chara-ext-asset_:" + assetIndex, b64encoded);
                }
            }

            if (
                card.data.extensions.risuai.additionalAssets &&
                card.data.extensions.risuai.additionalAssets.length > 0
            ) {
                const keys = card.data.extensions.risuai.additionalAssets.map((asset) => asset[1]);
                for await (const { index: i, key, bytes } of loadAssetsInBatches(keys, { signal: controller.signal })) {
                    alertStore.set({
                        type: "progress",
                        msg: "Loading... (Adding Additional Assets)",
                        submsg: ((i / card.data.extensions.risuai.additionalAssets.length) * 100).toFixed(2),
                    });
                    const rData = assetBytes(key, bytes);
                    const b64encoded = Buffer.from(await compressImage(rData)).toString("base64");
                    assetIndex++;
                    card.data.extensions.risuai.additionalAssets[i][1] = `__asset:${assetIndex}`;
                    await writer.write("chara-ext-asset_:" + assetIndex, b64encoded);
                }
            }

            if (char.vits && char.ttsMode === "vits") {
                const keys = Object.keys(char.vits.files);
                const assetKeys = keys.map((key) => char.vits.files[key]);
                for await (const { index: i, key: assetKey, bytes } of loadAssetsInBatches(assetKeys, {
                    signal: controller.signal,
                })) {
                    alertStore.set({
                        type: "progress",
                        msg: "Loading... (Adding VITS)",
                        submsg: ((i / keys.length) * 100).toFixed(2),
                    });
                    const key = keys[i];
                    const rData = assetBytes(assetKey, bytes);
                    const b64encoded = Buffer.from(rData).toString("base64");
                    assetIndex++;
                    card.data.extensions.risuai.vits[key] = `__asset:${assetIndex}`;
                    await writer.write("chara-ext-asset_:" + assetIndex, b64encoded);
                }
            }
            if (type === "json") {
                await downloadFile(
                    `${char.name.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.json`,
                    Buffer.from(JSON.stringify(card, null, 4), "utf-8"),
                );
                return finish();
            }

            await sleep(10);
            alertStore.set({
                type: "wait",
                msg: "Loading... (Writing)",
            });

            await writer.write("chara", Buffer.from(JSON.stringify(card)).toString("base64"));
        } else if (spec === "v3") {
            const card = createBaseV3(char);
            const seenPaths = new Set<string>();
            if (card.data.assets && card.data.assets.length > 0) {
                const keys = card.data.assets
                    .filter((asset) => !(asset.uri === "ccdefault:" && type !== "png") && !isKnownUri(asset.uri))
                    .map((asset) => asset.uri);
                const reads = loadAssetsInBatches(keys, { signal: controller.signal });
                try {
                    // Walk the original list: URI skips and the portrait still control asset numbering.
                    for (let i = 0; i < card.data.assets.length; i++) {
                        alertStore.set({
                            type: "progress",
                            msg: "Loading... (Adding Assets)",
                            submsg: ((i / card.data.assets.length) * 100).toFixed(2),
                        });
                        let key = card.data.assets[i].uri;
                        let rData: Uint8Array;
                        if (key === "ccdefault:" && type !== "png") {
                            key = char.image;
                            rData = img;
                        } else if (isKnownUri(key)) {
                            continue;
                        } else {
                            const record = await reads.next();
                            if (record.done === true) throw new Error(language.errors.noData);
                            rData = assetBytes(key, record.value.bytes);
                        }
                        if (type === "json") {
                            // Counted as each asset arrives, so the refusal cancels the pending read.
                            jsonAssetBytes += rData.length;
                            if (jsonAssetBytes > JSON_EXPORT_ASSET_LIMIT) {
                                throw new Error(language.jsonExportTooLarge);
                            }
                        }
                        assetIndex++;
                        if (type === "png") {
                            const b64encoded = Buffer.from(await compressImage(rData)).toString("base64");
                            card.data.assets[i].uri = `__asset:${assetIndex}`;
                            await writer.write("chara-ext-asset_:" + assetIndex, b64encoded);
                        } else if (type === "json") {
                            const b64encoded = Buffer.from(await compressImage(rData)).toString("base64");
                            card.data.assets[i].uri = `data:application/octet-stream;base64,${b64encoded}`;
                        } else if (writer instanceof CharXWriter) {
                            let type = "other";
                            let itype = "other";
                            switch (card.data.assets[i].type) {
                                case "emotion":
                                    type = "emotion";
                                    break;
                                case "background":
                                    type = "background";
                                    break;
                                case "user_icon":
                                    type = "user_icon";
                                    break;
                                case "icon":
                                    type = "icon";
                                    break;
                            }
                            switch (card.data.assets[i].ext) {
                                case "png":
                                case "jpg":
                                case "jpeg":
                                case "gif":
                                case "webp":
                                case "avif":
                                    itype = "image";
                                    break;
                                case "mp3":
                                case "wav":
                                case "ogg":
                                case "flac":
                                    itype = "audio";
                                    break;
                                case "mp4":
                                case "webm":
                                case "mov":
                                case "avi":
                                case "mkv":
                                    itype = "video";
                                    break;
                                case "mmd":
                                case "obj":
                                    itype = "model";
                                    break;
                                case "safetensors":
                                case "cpkt":
                                case "onnx":
                                    itype = "ai";
                                    break;
                                case "otf":
                                case "ttf":
                                case "woff":
                                case "woff2":
                                    itype = "fonts";
                                    break;
                                case "js":
                                case "ts":
                                case "lua":
                                    itype = "code";
                            }

                            let path = "";
                            const name = Array.from(card.data.assets[i].name || `asset_${assetIndex}`)
                                .slice(0, 100)
                                .join("");
                            const ext = card.data.assets[i].ext === "unknown" ? "png" : card.data.assets[i].ext;
                            const baseDir =
                                card.data.assets[i].ext === "unknown"
                                    ? `assets/${type}/image`
                                    : `assets/${type}/${itype}`;

                            // Generate unique path to avoid duplicate filenames
                            let uniqueName = name;
                            let suffix = 0;
                            while (seenPaths.has(`${baseDir}/${uniqueName}.${ext}`)) {
                                suffix++;
                                uniqueName = `${name}_${suffix}`;
                            }
                            path = `${baseDir}/${uniqueName}.${ext}`;
                            seenPaths.add(path);

                            const imageType = getImageType(rData);
                            const metaPath = `x_meta/${uniqueName}.json`;
                            if (imageType === "PNG" && writer instanceof CharXWriter) {
                                const metadatas: Record<string, string> = {};
                                const gen = PngChunk.readGenerator(rData);
                                for await (const chunk of gen) {
                                    if (!chunk || chunk instanceof AppendableBuffer) {
                                        continue;
                                    }
                                    metadatas[chunk.key] = chunk.value;
                                }
                                if (Object.keys(metadatas).length > 0) {
                                    await writer.write(metaPath, Buffer.from(JSON.stringify(metadatas, null, 4)), 6);
                                } else {
                                    await writer.write(
                                        metaPath,
                                        Buffer.from(
                                            JSON.stringify({
                                                type: imageType,
                                            }),
                                            "utf-8",
                                        ),
                                        6,
                                    );
                                }
                            } else {
                                await writer.write(
                                    metaPath,
                                    Buffer.from(
                                        JSON.stringify({
                                            type: imageType,
                                        }),
                                        "utf-8",
                                    ),
                                    6,
                                );
                            }
                            const writtenPath = await writer.write(path, Buffer.from(await compressImage(rData)));
                            card.data.assets[i].uri = "embeded://" + writtenPath;
                        }
                    }
                } finally {
                    // Manual iteration must close the generator even when compression or a write fails.
                    await reads.return();
                }
            }
            if (type === "json") {
                await downloadFile(
                    `${char.name.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.json`,
                    Buffer.from(JSON.stringify(card, null, 4), "utf-8"),
                );
                return finish();
            }

            await sleep(10);
            alertStore.set({
                type: "wait",
                msg: "Loading... (Writing)",
            });

            if (type === "charx" || type === "charxJpeg") {
                const md: RisuModule = {
                    name: `${char.name} Module`,
                    description: "Module for " + char.name,
                    id: v4(),
                    trigger: card.data.extensions.risuai.triggerscript ?? [],
                    regex: card.data.extensions.risuai.customScripts ?? [],
                    lorebook: char.globalLore ?? [],
                };
                delete card.data.extensions.risuai.triggerscript;
                delete card.data.extensions.risuai.customScripts;
                const moduleBytes = await exportModuleLegacy(md, {
                    alertEnd: false,
                    saveData: false,
                });
                if (!moduleBytes) throw new Error(language.errors.noData);
                await writer.write("module.risum", moduleBytes);
                await writer.write("card.json", Buffer.from(JSON.stringify(card, null, 4)));
            } else {
                await writer.write("ccv3", Buffer.from(JSON.stringify(card)).toString("base64"));
            }
        }
        await writer.end();

        await sleep(10);

        return finish();
    } catch (e) {
        controller.abort(e);
        await localWriter?.abort(e);
        if (arg.writer) throw e;
        alertError(e);
    }
}

// Extended LorebookEntry with Risuai specific fields
type RisuLorebookEntry = LorebookEntry & {
    mode?: string;
    folder?: string;
};

export function createBaseV3(char: ClientCharacter) {
    let charBook: RisuLorebookEntry[] = [];
    let assets: Array<{
        type: string;
        uri: string;
        name: string;
        ext: string;
    }> = safeStructuredClone(char.ccAssets ?? []);

    if (char.additionalAssets) {
        for (const asset of char.additionalAssets) {
            assets.push({
                type: "x-risu-asset",
                uri: asset[1],
                name: asset[0],
                ext: asset[2] || "png",
            });
        }
    }

    if (char.emotionImages) {
        for (const asset of char.emotionImages) {
            assets.push({
                type: "emotion",
                uri: asset[1],
                name: asset[0],
                ext: "png",
            });
        }

        assets.push({
            type: "icon",
            uri: "ccdefault:",
            name: "main",
            ext: "png",
        });
    }

    for (const lore of char.globalLore) {
        let ext: {
            risu_case_sensitive?: boolean;
            risu_activationPercent?: number;
            risu_loreCache?: {
                key: string;
                data: string[];
            };
        } = safeStructuredClone(lore.extentions ?? {});

        let caseSensitive = ext.risu_case_sensitive ?? false;
        ext.risu_activationPercent = lore.activationPercent;
        ext.risu_loreCache = lore.loreCache;

        charBook.push({
            ...({
                keys: lore.key.split(",").map((r) => r.trim()),
                secondary_keys: lore.selective ? lore.secondkey.split(",").map((r) => r.trim()) : undefined,
                content: lore.content,
                extensions: ext,
                enabled: true,
                insertion_order: lore.insertorder,
                constant: lore.alwaysActive,
                selective: lore.selective,
                name: lore.comment,
                comment: lore.comment,
                case_sensitive: caseSensitive,
                use_regex: lore.useRegex ?? false,
            } as LorebookEntry),
            mode: lore.mode ?? "normal",
            folder: lore.folder,
        });
    }
    char.loreExt ??= {};

    char.loreExt.risu_fullWordMatching = char.loreSettings?.fullWordMatching ?? false;

    const card: CharacterCardV3 = {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
            name: char.name,
            description: char.desc ?? "",
            personality: char.personality ?? "",
            scenario: char.scenario ?? "",
            first_mes: char.firstMessage ?? "",
            mes_example: char.exampleMessage ?? "",
            creator_notes: char.creatorNotes ?? "",
            system_prompt: char.systemPrompt ?? "",
            post_history_instructions: char.replaceGlobalNote ?? "",
            alternate_greetings: char.alternateGreetings ?? [],
            character_book: {
                scan_depth: char.loreSettings?.scanDepth,
                token_budget: char.loreSettings?.tokenBudget,
                recursive_scanning: char.loreSettings?.recursiveScanning,
                extensions: char.loreExt ?? {},
                entries: charBook,
            },
            tags: char.tags ?? [],
            creator: char.additionalData?.creator ?? "",
            character_version: `${char.additionalData?.character_version}` || "",
            extensions: {
                risuai: {
                    bias: char.bias,
                    viewScreen: char.viewScreen,
                    customScripts: char.customscript,
                    utilityBot: char.utilityBot,
                    sdData: char.sdData,
                    backgroundHTML: char.backgroundHTML,
                    license: char.license,
                    triggerscript: char.triggerscript,
                    additionalText: char.additionalText,
                    largePortrait: char.largePortrait,
                    lorePlus: char.lorePlus,
                    inlayViewScreen: char.inlayViewScreen,
                    newGenData: char.newGenData,
                    vits: {},
                    lowLevelAccess: char.lowLevelAccess ?? false,
                    defaultVariables: char.defaultVariables ?? "",
                    prebuiltAssetCommand: char.prebuiltAssetCommand ?? "",
                    prebuiltAssetExclude: char.prebuiltAssetExclude ?? [],
                    prebuiltAssetStyle: char.prebuiltAssetStyle ?? "",
                    toggles: char.customModuleToggle ?? "",
                    moduleNamespace: char.moduleNamespace,
                    hideChatIcon: char.hideChatIcon ?? false,
                },
                depth_prompt: char.depth_prompt,
            },
            group_only_greetings: char.group_only_greetings ?? [],
            nickname: char.nickname ?? "",
            source: char.source ?? [],
            creation_date: char.creation_date ?? 0,
            modification_date: Math.floor(Date.now() / 1000),
            assets: assets,
        },
    };

    if (char.extentions) {
        for (const key in char.extentions) {
            if (key === "risuai" || key === "depth_prompt") {
                continue;
            }
            card.data.extensions[key] = char.extentions[key];
        }
    }
    return card;
}

export type hubType = {
    name: string;
    desc: string;
    download: string;
    id: string;
    img: string;
    tags: string[];
    viewScreen: "none" | "emotion" | "imggen";
    hasLore: boolean;
    hasEmotion: boolean;
    hasAsset: boolean;
    creator?: string;
    creatorName?: string;
    hot: number;
    license: string;
    authorname?: string;
    original?: string;
    type: string;
    hidden?: boolean;
};

export let hubAdditionalHTML = "";

export async function getRisuHub(arg: {
    search: string;
    page: number;
    nsfw: boolean;
    sort: string;
}): Promise<hubType[]> {
    try {
        arg.search += " __shared";
        const stringArg = `search==${arg.search}&&page==${arg.page}&&nsfw==${arg.nsfw}&&sort==${arg.sort}&&web==other`;

        const da = await fetch(hubURL + "/realm/" + encodeURIComponent(stringArg) + "?cache=30", {
            headers: {
                "x-risuai-info": appVer + ";node",
            },
        });
        if (da.status !== 200) {
            return [];
        }
        const jso = await da.json();
        if (Array.isArray(jso)) {
            return jso;
        }
        hubAdditionalHTML = jso.additionalHTML || hubAdditionalHTML;
        return jso.cards;
    } catch (error) {
        return [];
    }
}

export async function downloadRisuHub(
    id: string,
    arg: {
        forceRedirect?: boolean;
    } = {},
) {
    try {
        if (!arg.forceRedirect) {
            alertStore.set({
                type: "wait",
                msg: "Downloading...",
            });
        }
        // The server downloads the card, stores its assets, and answers the read parts
        // (`POST /api/import/realm`): the tab never fetches Realm or holds the file.
        let download: RealmImportResult;
        try {
            download = await importRealmOverServer(id, {
                onProgress: (done, total) => {
                    alertWait(`Loading... (Saving Assets ${done}/${total})`);
                },
            });
        } catch (error) {
            alertError(realmImportErrorMessage(error));
            return;
        }

        if (download.kind !== "json") {
            incrementStatic("imports");
            let imported: string | null | undefined | false;
            if (download.kind === "charx") {
                const { card, moduleData, assets } = download;
                imported = (await importCharxCard(
                    card,
                    moduleData === null ? null : Buffer.from(moduleData, "base64"),
                    async () => assets,
                )) as string | null | undefined;
            } else if (download.card === null) {
                alertError(language.errors.noData);
                imported = null;
            } else {
                imported = await importPngCard(download.card, download.image, download.assets);
            }
            checkCharOrder();
            if (imported && (settings.ui.goCharacterOnImport || arg.forceRedirect)) {
                changeChar(imported);
            }
            return;
        }

        const result = JSON.parse(download.body);
        const data: CharacterCardV3 = result.card;
        const img: string = result.img;

        data.data.extensions.risuRealmImportId = id;

        const imported = await importCharacterCardSpec(data, await getHubResources(img), "hub");
        checkCharOrder();
        if (imported && (settings.ui.goCharacterOnImport || arg.forceRedirect)) {
            changeChar(imported);
            alertStore.set({
                type: "none",
                msg: "",
            });
        }
    } catch (error) {
        console.error(error);
        console.log(error.stack);
        alertError("Error while importing");
    }
}

export async function getHubResources(id: string) {
    const res = await fetch(`${hubURL}/resource/${id}`);
    if (res.status !== 200) {
        throw await res.text();
    }
    return Buffer.from(await res.arrayBuffer());
}

export function isCharacterHasAssets(char: AnyClientCharacter) {
    if (char.type === "group") {
        return false;
    }

    if (char.additionalAssets && char.additionalAssets.length > 0) {
        return true;
    }

    if (char.emotionImages && char.emotionImages.length > 0) {
        return true;
    }

    if (char.ccAssets && char.ccAssets.length > 0) {
        return true;
    }

    return false;
}

type CharacterCardV2Risu = {
    spec: "chara_card_v2";
    spec_version: "2.0"; // May 8th addition
    data: {
        name: string;
        description: string;
        personality: string;
        scenario: string;
        first_mes: string;
        mes_example: string;
        creator_notes: string;
        system_prompt: string;
        post_history_instructions: string;
        alternate_greetings: string[];
        character_book?: CharacterBook;
        tags: string[];
        creator: string;
        character_version: string;
        extensions: {
            risuai?: {
                emotions?: [string, string][];
                bias?: [string, number][];
                viewScreen?: any;
                customScripts?: customscript[];
                utilityBot?: boolean;
                sdData?: [string, string][];
                additionalAssets?: [string, string, string][];
                backgroundHTML?: string;
                license?: string;
                triggerscript?: triggerscript[];
                private?: boolean;
                additionalText?: string;
                largePortrait?: boolean;
                lorePlus?: boolean;
                inlayViewScreen?: boolean;
                newGenData?: {
                    prompt: string;
                    negative: string;
                    instructions: string;
                    emotionInstructions: string;
                };
                vits?: { [key: string]: string };
            };
            depth_prompt?: { depth: number; prompt: string };
        };
    };
};

interface OldTavernChar {
    avatar: "none";
    chat: string;
    create_date: string;
    description: string;
    first_mes: string;
    mes_example: string;
    name: string;
    personality: string;
    scenario: string;
    talkativeness: "0.5";
    spec_version?: "1.0";
}
type CharacterBook = {
    name?: string;
    description?: string;
    scan_depth?: number; // agnai: "Memory: Chat History Depth"
    token_budget?: number; // agnai: "Memory: Context Limit"
    recursive_scanning?: boolean; // no agnai equivalent. whether entry content can trigger other entries
    extensions: Record<string, any>;
    entries: Array<charBookEntry>;
};

interface charBookEntry {
    keys: Array<string>;
    content: string;
    extensions: Record<string, any>;
    enabled: boolean;
    insertion_order: number; // if two entries inserted, lower "insertion order" = inserted higher

    // FIELDS WITH NO CURRENT EQUIVALENT IN SILLY
    name?: string; // not used in prompt engineering
    priority?: number; // if token budget reached, lower priority value = discarded first

    // FIELDS WITH NO CURRENT EQUIVALENT IN AGNAI
    id?: number; // not used in prompt engineering
    comment?: string; // not used in prompt engineering
    selective?: boolean; // if `true`, require a key from both `keys` and `secondary_keys` to trigger the entry
    secondary_keys?: Array<string>; // see field `selective`. ignored if selective == false
    constant?: boolean; // if true, always inserted in the prompt (within budget limit)
    position?: "before_char" | "after_char"; // whether the entry is placed before or after the character defs
    case_sensitive?: boolean;
    use_regex?: boolean;
    mode?: string; // Risuai mode field
    folder?: string; // Risuai folder field
}

interface RccCardMetaData {
    usePassword?: boolean;
}
