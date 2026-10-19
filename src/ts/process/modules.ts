import { selectedCharacter, characterList } from "../storage/characterStore.svelte";
import { settings, activePreset, readPresetFieldOf, type PresetScope } from "../storage/settingsViews.svelte";
import { chatDisplayIds } from "../storage/chatBinding.svelte";
import { language } from "src/lang";
import {
    alertClear,
    alertConfirm,
    alertError,
    alertModuleSelect,
    alertNormal,
    alertStore,
    alertWait,
    waitAlert,
} from "../alert";
import type { customscript, loreBook, triggerscript } from "../storage/database.svelte";
import { findChat, selectedChat } from "../storage/chatStore.svelte";
import { LocalWriter, saveAsset, VirtualWriter } from "../globalApi.svelte";
import { checkPersonaBinded, selectSingleFileHandle } from "../util";
import { loadAssetsInBatches, saveAssets } from "../storage/assetQueue";
import { importModuleOverServer } from "../storage/moduleImportClient";
import { ServerImportFailedError, ServerImportRequestError } from "../storage/serverImportClient";
import { v4 } from "uuid";
import { convertExternalLorebook } from "./lorebook.svelte";
import { compressImage } from "../media";
import { decodeRPack, encodeRPack } from "../rpack/rpack_js";
import {
    alertStore as currentAlertStore,
    HideIconStore,
    moduleBackgroundEmbedding,
    ReloadGUIPointer,
} from "../stores.svelte";
import { addModule } from "../storage/collectionStore.svelte";
import { beginMutationScope, flushResources, GenerationBlockedError } from "../storage/resourceSync.svelte";
import { get } from "svelte/store";
import { moduleMembershipRevision, moduleAssetsRevision, moduleFieldPlain } from "../storage/records.svelte";
import { untrack } from "svelte";
import { convertCharacterToModule, convertModuleToCharacter } from "../interchangeability";
import { exportCharacterCard, importCharacterProcess } from "../characterCards";
import { upgradeLorebook, type RisuModule } from "../../../shared/modules.ts";
import { personaLinksModule, personaModuleIdSet } from "../../../shared/personas.ts";
import {
    decodeModuleMain,
    MODULE_FILE_HEADER_BYTES,
    ModuleFileError,
    type ModuleImportResult,
    readModuleFileHeader,
} from "../../../shared/moduleImport.ts";

export type { MCPModule, RisuModule } from "../../../shared/modules.ts";

export async function exportModule(
    module: RisuModule,
    arg: {
        alertEnd?: boolean;
    } = {},
) {
    const alertEnd = arg.alertEnd ?? true;

    const writer = new LocalWriter();
    try {
        const char = convertModuleToCharacter(module);
        if (!char.image) {
            const res = await fetch("/none.webp");
            const data = new Uint8Array(await res.arrayBuffer());
            char.image = await saveAsset(data);
            char.extentions ??= {};
            char.extentions["moduleNoneImage"] = true;
        }
        await writer.init(module.name + ".module", ["charx"]);
        const result = await exportCharacterCard(char, "charx", {
            spec: "v3",
            writer,
        });
        if (alertEnd) {
            alertNormal(
                result.missingAssets > 0
                    ? language.exportMissingAssets.replace("{count}", String(result.missingAssets))
                    : language.successExport,
            );
        }
    } catch (error) {
        // Also covers failures before handing the writer to exportCharacterCard.
        await writer.abort(error);
        alertError(error);
    }
}

export async function exportModuleLegacy(
    module: RisuModule,
    arg: {
        alertEnd?: boolean;
        saveData?: boolean;
    } = {},
): Promise<Uint8Array | undefined> {
    const alertEnd = arg.alertEnd ?? true;
    const saveData = arg.saveData ?? true;
    const writer = saveData ? new LocalWriter() : new VirtualWriter();
    const controller = new AbortController();
    let missingAssets = 0;
    try {
        // Capture tuples before any await: metadata and payloads must use the same order even
        // if the live module is edited while a batch is being read or written.
        const assets = (module.assets ?? []).map((asset) => [...asset] as [string, string, string]);
        module = safeStructuredClone(module);
        module.assets = assets.map((asset) => [asset[0], "", asset[2]]);

        const mainbuf = await encodeRPack(
            Buffer.from(
                JSON.stringify(
                    {
                        module: module,
                        type: "risuModule",
                    },
                    null,
                    2,
                ),
                "utf-8",
            ),
        );
        if (writer instanceof LocalWriter) {
            await writer.init(module.name, ["risum"]);
        }
        const writeLength = async (len: number) => {
            const lenbuf = Buffer.alloc(4);
            lenbuf.writeUInt32LE(len, 0);
            await writer.write(lenbuf);
        };
        const writeByte = async (byte: number) => {
            await writer.write(new Uint8Array([byte]));
        };

        await writeByte(111); //magic number
        await writeByte(0); //version
        await writeLength(mainbuf.length);
        await writer.write(mainbuf);

        const keys = assets.map((asset) => asset[1]);
        for await (const { index, key, bytes } of loadAssetsInBatches(keys, { signal: controller.signal })) {
            alertStore.set({
                type: "wait",
                msg: `Loading... (Adding Assets ${index} / ${assets.length})`,
            });
            if (bytes === null) {
                missingAssets++;
                console.warn("Export asset missing or empty:", key);
            }
            const encoded = await encodeRPack(Buffer.from(await compressImage(bytes ?? new Uint8Array(0))));
            await writeByte(1); //mark as asset
            await writeLength(encoded.length);
            await writer.write(encoded);
        }

        await writeByte(0); //end of file
        await writer.close();
        const result = writer instanceof VirtualWriter ? writer.buf.buffer : undefined;
        if (alertEnd) {
            alertNormal(
                missingAssets > 0
                    ? language.exportMissingAssets.replace("{count}", String(missingAssets))
                    : language.successExport,
            );
        }
        return result;
    } catch (error) {
        controller.abort(error);
        await writer.abort(error);
        if (!saveData && !alertEnd) {
            throw error;
        }
        alertError(error);
    }
}

/**
 * The in-tab `.risum` reader: the CharX-embedded `module.risum` (small) and tests. A `.risum` file
 * goes through `importModuleFile` instead, which never holds the file (large-asset-import slice 2c).
 */
export async function readModule(buf: Buffer): Promise<RisuModule> {
    let pos = 0;

    const readLength = () => {
        const len = buf.readUInt32LE(pos);
        pos += 4;
        return len;
    };
    const readByte = () => {
        const byte = buf.readUInt8(pos);
        pos += 1;
        return byte;
    };
    const readData = (len: number) => {
        const data = buf.subarray(pos, pos + len);
        pos += len;
        return data;
    };

    if (readByte() !== 111) {
        console.error("Invalid magic number");
        alertError(language.errors.noData);
        return;
    }
    if (readByte() !== 0) {
        //Version check
        console.error("Invalid version");
        alertError(language.errors.noData);
        return;
    }

    const mainLen = readLength();
    const mainData = readData(mainLen);
    const main: {
        type: "risuModule";
        module: RisuModule;
    } = JSON.parse(Buffer.from(await decodeRPack(mainData)).toString());

    if (main.type !== "risuModule") {
        console.error("Invalid module type");
        alertError(language.errors.noData);
        return;
    }

    let module = main.module;

    // Each asset record is decoded inside its queue item's `load()`, so no more than the queue's
    // concurrency decoded copies exist at once; the asset client retries a refused write itself.
    const assetRecords: Uint8Array[] = [];
    while (true) {
        const mark = readByte();
        if (mark === 0) {
            break;
        }
        if (mark !== 1) {
            alertError(language.errors.noData);
            return;
        }
        const len = readLength();
        assetRecords.push(readData(len));
    }

    const totalAssets = module.assets?.length ?? 0;
    try {
        const keys = await saveAssets(
            assetRecords.map((record, index) => ({
                load: () => {
                    if (!module.assets?.[index]) {
                        throw new Error(`Missing asset metadata for index ${index}`);
                    }
                    return decodeRPack(record);
                },
            })),
            {
                onProgress: (done) => {
                    alertWait(`Loading... (Adding Assets ${done} / ${totalAssets})`);
                },
            },
        );
        // One replacement of the list; metadata past the stored records keeps its key.
        if (keys.length > 0) {
            module.assets = module.assets.map((asset, index) => {
                if (index >= keys.length) return asset;
                const filled: [string, string, string] = [...asset];
                filled[1] = keys[index];
                return filled;
            });
        }
    } finally {
        alertClear();
    }

    module.id = v4();
    return module;
}

/**
 * Prepares an imported module's lorebook before the module is added (every module import path calls
 * it): old-format entries are converted (`upgradeLorebook`); a lorebook that is not a list (a
 * corrupted export) is reported and the user asked whether to import it with an empty one; a
 * lorebook whose entries cannot be read is reported. Returns false when the module is not to be
 * imported (the module mutations refuse a non-list lorebook rather than drop it).
 */
export async function prepareModuleImport(module: { name?: unknown; lorebook?: unknown }): Promise<boolean> {
    if (module.lorebook === undefined) {
        return true;
    }
    if (Array.isArray(module.lorebook)) {
        try {
            module.lorebook = upgradeLorebook(module.lorebook);
        } catch (error) {
            console.error(error);
            alertError(language.errors.noData);
            return false;
        }
        return true;
    }
    alertError(language.bootstrap.dataCorruptionDetected(String(module.name || "Unknown"), typeof module.lorebook));
    await waitAlert();
    if (!(await alertConfirm(language.bootstrap.resetLorebookQuestion))) {
        return false;
    }
    module.lorebook = [];
    return true;
}

/**
 * Imports a `.risum` file through the server (historical `docs/plan/large-asset-import.md` slice 2c); every
 * `.risum` file entry point (the module dialog, the drop, `#share_module`, `#import=`, the launch
 * queue) calls it, then adds the module itself. Only the file's header and main record are read
 * here (`file.slice`, decoded with the reader the server uses, `shared/moduleImport.ts`), and on that
 * module, before anything is sent, the low-level access question is asked and `prepareModuleImport`
 * runs. Then the file itself is uploaded (`importModuleOverServer`, its progress in the wait alert),
 * and only the stored assets' keys are taken from the server's result. Returns the prepared module
 * under a fresh id, or null when nothing is to be added: a question was declined, or the failure is
 * already alerted.
 */
export async function importModuleFile(file: Blob): Promise<RisuModule | null> {
    alertWait("Loading... (Reading)");
    let module: RisuModule;
    try {
        module = await readModuleFileMain(file);
    } catch (error) {
        console.error(error);
        alertError(language.errors.noData);
        return null;
    }
    if (module.lowLevelAccess && !(await alertConfirm(language.lowLevelAccessConfirm))) {
        return null;
    }
    if (!(await prepareModuleImport(module))) {
        return null;
    }
    alertWait(language.moduleImportUploading);
    let stored: ModuleImportResult;
    try {
        stored = await importModuleOverServer(file, {
            onProgress: (done, total) => {
                alertWait(`Loading... (Adding Assets ${done} / ${total})`);
            },
        });
    } catch (error) {
        // Each alert replaces the wait alert; nothing clears the store after it.
        alertError(moduleImportErrorMessage(error));
        return null;
    }
    if (!copyStoredKeys(module, stored.module)) {
        console.error("[Module import] The server's module does not match the file's asset list");
        alertError(language.errors.noData);
        return null;
    }
    module.id = v4();
    alertClear();
    return module;
}

/**
 * The module of a `.risum` file's main record, read from the file's first bytes only (its header,
 * then its main record). Throws `ModuleFileError` for a file that is not a module file.
 */
async function readModuleFileMain(file: Blob): Promise<RisuModule> {
    const header = new Uint8Array(await file.slice(0, MODULE_FILE_HEADER_BYTES).arrayBuffer());
    const { mainLength } = readModuleFileHeader(header);
    // A fresh buffer the decoder may decode in place.
    const main = new Uint8Array(
        await file.slice(MODULE_FILE_HEADER_BYTES, MODULE_FILE_HEADER_BYTES + mainLength).arrayBuffer(),
    );
    if (main.length !== mainLength) {
        throw new ModuleFileError("The module file is truncated");
    }
    return decodeModuleMain(main);
}

/**
 * Copies each asset's stored key (`assets[i][1]`) from the server's copy of the module into `module`.
 * False, copying nothing, unless both asset lists have the same length (a missing list counts as an
 * empty one) and every entry of the server's is a list.
 */
function copyStoredKeys(module: RisuModule, stored: RisuModule): boolean {
    const local = module.assets ?? [];
    const answer: unknown = stored.assets ?? [];
    if (!Array.isArray(answer) || answer.length !== local.length || !answer.every((entry) => Array.isArray(entry))) {
        return false;
    }
    // An absent list stays absent (the server's is empty then).
    if (module.assets) {
        module.assets = local.map((asset, index) => {
            const filled: [string, string, string] = [...asset];
            filled[1] = (answer as unknown[][])[index][1] as string;
            return filled;
        });
    }
    return true;
}

/** The texts one server file import route's failures map to (`serverImportErrorMessage`). */
export type ServerImportTexts = {
    /** The route's `error` text for a file it cannot read (a 400, or a failure line): shown as `noData`. */
    invalidFile: string;
    /** A 413 `File too large`. */
    fileTooLarge: string;
    /** A 413 `Asset too large` (the module import's). */
    assetTooLarge?: string;
    /** Another non-2xx answer without an `error` text (`{{status}}`). */
    requestFailed: string;
    /** A failure line (`{{error}}`). */
    stopped: string;
    /** A network failure (the Realm download's own text); default the module import's upload text. */
    interrupted?: string;
};

/**
 * The alert for a file upload to a server import route that failed (slices 2c and 2d): by the
 * answer's status and its `error` text where the server's texts tell refusals apart (every
 * authentication failure is a 400 with its own text, shown as it is). Busy, maintenance, a timeout,
 * and an interrupted upload share the module import's texts. A network failure may be a refusal the
 * browser did not see (see `serverImportClient.ts`).
 */
export function serverImportErrorMessage(error: unknown, texts: ServerImportTexts): string {
    if (error instanceof ServerImportRequestError) {
        switch (error.status) {
            case 400:
                if (error.serverError === texts.invalidFile) {
                    return language.errors.noData;
                }
                break;
            case 413:
                if (error.serverError === "File too large") {
                    return texts.fileTooLarge;
                }
                if (texts.assetTooLarge !== undefined && error.serverError === "Asset too large") {
                    return texts.assetTooLarge;
                }
                break;
            case 408:
                return language.moduleImportTimeout;
            case 409:
            case 429:
                return language.moduleImportBusy;
            case 503:
                return language.moduleImportMaintenance;
        }
        return error.serverError ?? texts.requestFailed.replace("{{status}}", String(error.status));
    }
    if (error instanceof ServerImportFailedError) {
        if (error.message === texts.invalidFile) {
            return language.errors.noData;
        }
        return texts.stopped.replace("{{error}}", error.message);
    }
    if (error instanceof TypeError) {
        return texts.interrupted ?? language.moduleImportInterrupted;
    }
    console.error(error);
    return language.errors.noData;
}

/** The alert for a `.risum` upload that failed (slice 2c). */
function moduleImportErrorMessage(error: unknown): string {
    return serverImportErrorMessage(error, {
        invalidFile: "Invalid module file",
        fileTooLarge: language.moduleImportFileTooLarge,
        assetTooLarge: language.moduleImportAssetTooLarge,
        requestFailed: language.moduleImportRequestFailed,
        stopped: language.moduleImportStopped,
    });
}

/**
 * Adds an imported module and waits until the server holds it: the save runs at once
 * (`flushResources` in a mutation scope begun before the add), with `moduleImportSaving` in the wait
 * alert. True when the module is saved; replaces only its own wait alert with success or clears it.
 * A conflict that replaced this tab's modules with another writer's (`modules/main` in the scope's
 * `discarded`: a change of the same module, or any change of this tab's other than adding the module)
 * dropped it:
 * `moduleImportDiscarded`. A flush that fails (a generation this tab's other changes wait for, a
 * refused or unreachable save) is `moduleImportUnconfirmed`; the module stays in the list unless a
 * conflict discarded it, in which case it is `moduleImportDiscarded` even if the flush later fails.
 * The flush saves every pending change, not only the module.
 */
async function addImportedModule(module: unknown, { announce }: { announce: boolean }): Promise<boolean> {
    const scope = beginMutationScope();
    const id = addModule(module);
    alertWait(language.moduleImportSaving);
    let discarded: string[];
    try {
        ({ discarded } = await flushResources({ scope }));
    } catch (error) {
        if (!settings.modules.some((entry) => entry.id === id)) {
            alertError(language.moduleImportDiscarded);
            return false;
        }
        const reason =
            error instanceof GenerationBlockedError
                ? language.chatGenerating
                : error instanceof Error
                  ? error.message
                  : String(error);
        alertError(language.moduleImportUnconfirmed.replace("{{error}}", reason));
        return false;
    }
    if (discarded.includes("modules/main")) {
        alertError(language.moduleImportDiscarded);
        return false;
    }
    const alert = get(currentAlertStore);
    if (alert.type === "wait" && alert.msg === language.moduleImportSaving) {
        if (announce) {
            alertNormal(language.successImport);
        } else {
            alertClear();
        }
    }
    return true;
}

export async function importModule() {
    const file = await selectSingleFileHandle(["json", "lorebook", "risum", "charx"]);
    if (!file) {
        return;
    }
    if (file.name.endsWith(".charx")) {
        try {
            // The picked `File` itself, which goes to the server's CharX import (large-asset-import
            // slice 2d).
            const char = await importCharacterProcess({
                name: file.name,
                data: file,
                returnCharacter: true,
            });
            if (char === null || char === undefined) {
                // Alerted already: no card, or the upload's failure (busy, too large, interrupted).
                return;
            }
            if (!char || typeof char === "string") {
                alertError(language.errors.noData);
                return;
            }
            const module = convertCharacterToModule(char);
            if (await prepareModuleImport(module)) {
                await addImportedModule(module, { announce: true });
            }
        } catch (error) {
            console.error(error);
            alertError(language.errors.noData);
        }
        return;
    }
    if (file.name.endsWith(".risum")) {
        try {
            // Prepared already; null when declined or failed (alerted).
            const module = await importModuleFile(file);
            if (!module) {
                return false;
            }
            await addImportedModule(module, { announce: true });
        } catch (error) {
            console.error(error);
            alertError(language.errors.noData);
        }
        return;
    }
    try {
        const fileData = new Uint8Array(await file.arrayBuffer());
        const importData = JSON.parse(Buffer.from(fileData).toString());
        if (importData.type === "risuModule") {
            if (!importData.name || !importData.id) {
                alertError(language.errors.noData);
                return;
            }
            importData.id = v4();

            if (importData.lowLevelAccess) {
                const conf = await alertConfirm(language.lowLevelAccessConfirm);
                if (!conf) {
                    return false;
                }
            }
            if (await prepareModuleImport(importData)) {
                await addImportedModule(importData, { announce: false });
            }
            return;
        }
        // importData.type === 'risu' in conflict with HypaV3 preset exports
        // difference: record vs. array
        if (importData.type === "risu" && importData.data && Array.isArray(importData.data)) {
            const lores: loreBook[] = importData.data;
            const importModule = {
                name: importData.name || "Imported Lorebook",
                description: importData.description || "Converted from risu lorebook",
                lorebook: lores,
                id: v4(),
            };
            if (await prepareModuleImport(importModule)) {
                await addImportedModule(importModule, { announce: false });
            }
            return;
        }
        if (importData.entries) {
            const lores: loreBook[] = convertExternalLorebook(importData.entries);
            const importModule = {
                name: importData.name || "Imported Lorebook",
                description: importData.description || "Converted from external lorebook",
                lorebook: lores,
                id: v4(),
            };
            if (await prepareModuleImport(importModule)) {
                await addImportedModule(importModule, { announce: false });
            }
            return;
        }
        if (importData.type === "regex" && importData.data) {
            const regexs: customscript[] = importData.data;
            const importModule = {
                name: importData.name || "Imported Regex",
                description: importData.description || "Converted from risu regex",
                regex: regexs,
                id: v4(),
            };
            await addImportedModule(importModule, { announce: false });
            return;
        }
    } catch (error) {
        console.error(error);
    }

    alertNormal(language.errors.noData);
}

function getModuleById(id: string) {
    for (let i = 0; i < settings.modules.length; i++) {
        if (settings.modules[i].id === id) {
            return settings.modules[i];
        }
    }

    if (id === "$embedded") {
        const persona = checkPersonaBinded();
        if (persona && persona.embeddedModule) {
            return persona.embeddedModule;
        }
    }
    return null;
}

/** The stored modules `ids` name (by id or namespace) or `personaIds` links (`personaLinksModule`), first of an id. */
function getModuleByIds(ids: string[], personaIds: ReadonlySet<string> = new Set()) {
    const idSet = new Set(ids);
    const modules = (settings.modules ?? []).filter(
        (m) => idSet.has(m.id) || (m.namespace && idSet.has(m.namespace)) || personaLinksModule(personaIds, m),
    );
    return deduplicateModuleById(modules);
}

function deduplicateModuleById(modules: RisuModule[]) {
    let ids: string[] = [];
    let newModules: RisuModule[] = [];
    for (let i = 0; i < modules.length; i++) {
        if (ids.includes(modules[i].id)) {
            continue;
        }
        ids.push(modules[i].id);
        newModules.push(modules[i]);
    }
    return newModules;
}

let lastModules = "";
let lastModuleRevision = -1;
let lastModuleData: RisuModule[] = [];
/** A chat by id (structural, so this module does not depend on the chat module). */
export type ModuleChatRef = { chaId: string; chatId: string } | null | undefined;

/**
 * The enabled modules for `chatRef`'s chat and character (default: the selected ones): the global
 * list, the chat's and the character's modules, the bound persona's embedded module, and the
 * prompt preset's integration list, all matched by id or namespace, plus the bound persona's linked
 * modules, matched apart (by id only, MCP modules excepted: `personaLinksModule`). The integration
 * list is `scope`'s preset's (a parse for a captured context, a `presetChain` pick included), else
 * `chatRef`'s display preset's (`docs/plan/chat-binding.md`), else the settings view's, which
 * follows the selected chat.
 */
export function getModules(chatRef?: ModuleChatRef, scope?: PresetScope) {
    const revision = moduleMembershipRevision();
    const { ids, personaIds } = enabledModuleIds(chatRef, scope);
    // The persona's links resolve apart from the other ids (by id only), so they key apart too.
    const idsJoined = JSON.stringify([ids, [...personaIds]]);
    if (lastModules === idsJoined && lastModuleRevision === revision) {
        return lastModuleData;
    }

    // Membership is tracked by the revision, including on cache hits. Filtering need not track
    // every wrapper read, which would give a cache miss different dependencies from a hit.
    const modules = untrack(() => getModuleByIds(ids, personaIds));
    lastModules = idsJoined;
    lastModuleRevision = revision;
    lastModuleData = modules;
    return modules;
}

/** The ids and persona links `getModules` resolves. */
function enabledModuleIds(chatRef: ModuleChatRef, scope: PresetScope | undefined) {
    const character = chatRef ? characterList().find((entry) => entry?.chaId === chatRef.chaId) : selectedCharacter();
    const currentChat = chatRef ? findChat(chatRef) : selectedChat();
    const persona = checkPersonaBinded(chatRef);
    let ids = settings.enabledModules ?? [];
    if (currentChat) {
        ids = ids.concat(currentChat.modules ?? []);
    }
    if (character && character.modules) {
        ids = ids.concat(character.modules);
    }
    if (persona && persona.embeddedModule) {
        ids = ids.concat([persona.embeddedModule?.id]);
    }
    const personaIds = personaModuleIdSet(persona);
    const integration =
        scope || chatRef
            ? (readPresetFieldOf(scope ?? chatDisplayIds(chatRef!), "moduleIntergration") as string | undefined)
            : activePreset.moduleIntergration;
    if (integration) {
        const intList = integration.split(",").map((s) => s.trim());
        ids = ids.concat(intList);
    }
    return { ids, personaIds };
}

/** The lorebooks of `getModules(chatRef, scope)`. */
export function getModuleLorebooks(chatRef?: ModuleChatRef, scope?: PresetScope) {
    const modules = getModules(chatRef, scope);
    let lorebooks: loreBook[] = [];
    for (const module of modules) {
        if (!module) {
            continue;
        }
        if (module.lorebook) {
            lorebooks = lorebooks.concat(module.lorebook);
        }
    }
    return lorebooks;
}

type ModuleAssets = NonNullable<RisuModule["assets"]>;
type AssetSetMemo = { next: WeakMap<ModuleAssets, AssetSetMemo>; assets?: ModuleAssets };
const assetSets: AssetSetMemo = { next: new WeakMap() };

/**
 * Plain tuples shared by element/assets stamp, never record wrappers. The version tracks edits;
 * unchanged enabled copies keep the aggregate's identity, so derived consumers ignore disabled
 * modules' edits. The copy cache is independent of the save loop and survives enable/disable.
 */
export function getModuleAssets(chatRef?: ModuleChatRef, modules: RisuModule[] = getModules(chatRef)) {
    moduleAssetsRevision();
    const parts: ModuleAssets[] = [];
    let memo = assetSets;
    for (const module of modules) {
        if (!module) continue;
        const part = moduleFieldPlain(module, "assets");
        if (!part) continue;
        parts.push(part);
        let next = memo.next.get(part);
        if (!next) {
            next = { next: new WeakMap() };
            memo.next.set(part, next);
        }
        memo = next;
    }
    // Key by copies, not the last caller's context: another chat's read must not make a disabled
    // module edit replace this chat's value. Weak keys release obsolete stamps and combinations.
    return (memo.assets ??= ([] as ModuleAssets).concat(...parts));
}

export function getModuleTriggers(chatRef?: ModuleChatRef) {
    const modules = getModules(chatRef);
    let triggers: triggerscript[] = [];
    for (const module of modules) {
        if (!module) {
            continue;
        }
        if (module.trigger) {
            triggers = triggers.concat(
                module.trigger.map((t) => {
                    t.lowLevelAccess = module.lowLevelAccess;
                    return t;
                }),
            );
        }
    }
    return triggers;
}

export function getModuleRegexScripts(chatRef?: ModuleChatRef) {
    const modules = getModules(chatRef);
    let customscripts: customscript[] = [];
    for (const module of modules) {
        if (!module) {
            continue;
        }
        if (module.regex) {
            customscripts = customscripts.concat(module.regex);
        }
    }
    return customscripts;
}

export function getModuleToggles(chatRef?: ModuleChatRef, scope?: PresetScope) {
    const modules = getModules(chatRef, scope);
    let costomModuleToggles: string = "";
    for (const module of modules) {
        if (!module) {
            continue;
        }
        if (typeof module.customModuleToggle === "string" && module.customModuleToggle) {
            costomModuleToggles += "\n" + module.customModuleToggle + "\n";
        }
    }
    return costomModuleToggles;
}

/** The MCP servers of the enabled modules for `chatRef`'s chat (default: the selected one). */
export function getModuleMcps(chatRef?: ModuleChatRef) {
    const modules = getModules(chatRef);

    return modules.map((v) => v.mcp?.url).filter((v) => v);
}

export async function applyModule() {
    // The character selected when the dialog opened, found again after it (it can be deleted meanwhile).
    const chaId = selectedCharacter()?.chaId;
    const sel = await alertModuleSelect();
    if (!sel) {
        return;
    }

    const module = safeStructuredClone(getModuleById(sel));
    if (!module) {
        return;
    }

    const currentChar = chaId === undefined ? undefined : characterList().find((entry) => entry?.chaId === chaId);
    if (!currentChar) {
        return;
    }
    if (currentChar.type === "group") {
        return;
    }

    if (module.lorebook) {
        for (const lore of module.lorebook) {
            currentChar.globalLore.push(lore);
        }
    }
    if (module.regex) {
        for (const regex of module.regex) {
            currentChar.customscript.push(regex);
        }
    }
    if (module.trigger) {
        for (const trigger of module.trigger) {
            currentChar.triggerscript.push(trigger);
        }
    }

    alertNormal(language.successApplyModule);
}

let lastModuleIds = "[]";
let lastReloadModules: RisuModule[] = [];

/**
 * Publishes icon/background settings and reloads once when the resolved elements/ids change. Membership
 * revision reads in getModules track replacements synchronously; content fields track themselves.
 * Store subscribers parse rows synchronously, so publish under untrack to keep their reads out.
 */
export function moduleUpdate() {
    const m = getModules();
    // JSON keeps hyphenated ids distinct. Duplicate ids can resolve to a different element after
    // a toggle (e.g. a namespace/persona previously selected only the second one), so compare
    // wrapper identities too, without ever reading retained wrappers that may now be detached.
    const ids = JSON.stringify(m.map((module) => module.id));
    const changed = lastModuleIds !== ids || m.some((module, i) => !Object.is(module, lastReloadModules[i]));

    let moduleHideIcon = false;
    let backgroundEmbedding = "";
    m.forEach((module) => {
        if (!module) {
            return;
        }

        if (module.hideIcon) {
            moduleHideIcon = true;
        }
        if (module.backgroundEmbedding) {
            backgroundEmbedding += "\n" + module.backgroundEmbedding + "\n";
        }
    });
    const hideIcon = selectedCharacter()?.hideChatIcon || moduleHideIcon;

    untrack(() => {
        // Also when empty: unlinking the last module with a background clears it.
        moduleBackgroundEmbedding.set(backgroundEmbedding);
        HideIconStore.set(hideIcon);

        lastModuleIds = ids;
        lastReloadModules = m;
        if (changed) {
            ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
        }
    });
}
