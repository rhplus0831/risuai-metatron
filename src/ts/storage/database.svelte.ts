import { get } from "svelte/store";
import { checkNullish, decryptBuffer, encryptBuffer, selectSingleFile } from "../util";
import { changeLanguage, language } from "../../lang";
import { downloadFile, saveAsset as saveImageGlobal } from "../globalApi.svelte";
import { alertNormal } from "../alert";
import { prebuiltPresets } from "../process/templates/templates";
import {
    defaultAIN,
    defaultOoba,
    newPresetId,
    normalizePreset,
    normalizePresets,
    normalizePromptTemplate,
    plainClone,
    PRESET_FIELDS,
    presetTemplate,
} from "../../../shared/presets.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { safeStructuredClone } from "../polyfill";
import { markCharacterDirtyAt } from "./resourceSync.svelte";
import { writeCharacterFieldsAt } from "./characterStore.svelte";
import { installForwarding, reconcileSelection, selectedPreset, selectedPresetForWrite } from "./forwarding.svelte";
import { copyPresetSecret, setPresetSecret } from "./llmSecrets.svelte";
import { selectPreset } from "./selection.svelte";
import type { botPreset, Chat, character, Database, groupChat, Message } from "../../../shared/database.ts";

//APP_VERSION_POINT is to locate the app version in the database file for version bumping
export let appVer = "2026.8.250"; //<APP_VERSION_POINT>
export let appSubVer = "";

export type * from "../../../shared/database.ts";
export { defaultAIN, defaultOoba, presetTemplate };
export type { DeepReadonly } from "../../../shared/readonly.ts";

/**
 * Installs `data` as `DBState.db` after the client-side defaults that remain: the Phase 1
 * collection guards, the removed-feature deletions, and the preset and persona backstops (the
 * shared normalizers the server also runs). The sections, the small collections, and the presets
 * arrive normalized by the server (`server/src/data/normalize/`), which owns their defaults; the
 * flat preset and persona fields and the selection indexes are forwarded (`forwarding.svelte.ts`).
 */
export function setDatabase(data: Database) {
    // Risu Account was removed; drop the login token older saves still carry.
    delete (data as Database & { account?: unknown }).account;
    // Cold storage was removed; drop its flag and the orphaned plugin-storage pointer map.
    delete (data as Database & { coldstorage?: unknown }).coldstorage;
    // Remote saving was removed with the save file; drop its flag.
    delete (data as Database & { enableRemoteSaving?: unknown }).enableRemoteSaving;
    if (data.pluginCustomStorage) {
        delete data.pluginCustomStorage._coldplugin;
    }
    if (checkNullish(data.characters)) {
        data.characters = [];
    }
    if (checkNullish(data.plugins)) {
        data.plugins = [];
    }
    // Every preset gets an id and the canonical fields (ids are assigned at creation from Phase 3 on;
    // the server normalizes too). An empty list becomes one default preset. A plain copy goes in:
    // the shared normalizer never receives a proxy.
    data.botPresets = normalizePresets(plainClone(data.botPresets));
    // The same contract as the server's: never empty, the four persona fields strings, unique ids.
    data.personas = normalizePersonas(plainClone(data.personas));
    data.modules ??= [];

    changeLanguage(data.language);
    setDatabaseLite(data);
}

/**
 * Installs `data` as `DBState.db`: the forwarding accessors go on first (on the raw object; the
 * live proxy passed back by a plugin setter already has them), then the selection is resolved
 * against the new collections.
 */
export function setDatabaseLite(data: Database) {
    installForwarding(data);
    DBState.db = data;
    reconcileSelection(DBState.db);
}

interface getDatabaseOptions {
    snapshot?: boolean;
}

export function getDatabase(options: getDatabaseOptions = {}): Database {
    if (options.snapshot) {
        return $state.snapshot(DBState.db) as Database;
    }
    return DBState.db as Database;
}

export function getCurrentCharacter(options: getDatabaseOptions = {}): character | groupChat {
    const db = getDatabase(options);
    if (!db.characters) {
        db.characters = [];
    }
    const char = db.characters?.[get(selectedCharID)];
    return char;
}

/**
 * Replaces a character's own fields with `char`'s, for the character with `char.chaId` (the one a
 * caller captured, not whatever is selected now). The mirror keeps its chats, selection, and render
 * key: chats are written only through the chat module, and a caller's copy may hold stale ones.
 */
export function setCurrentCharacter(char: character | groupChat) {
    if (!DBState.db.characters) {
        DBState.db.characters = [];
    }
    const index = DBState.db.characters.findIndex((entry) => entry?.chaId === char.chaId);
    if (index === -1) {
        return;
    }
    writeCharacterFieldsAt(index, char);
    // It may no longer be the selected character, which alone the save adapter watches.
    markCharacterDirtyAt(index);
}

export function getCharacterByIndex(index: number, options: getDatabaseOptions = {}): character | groupChat {
    const db = getDatabase(options);
    if (!db.characters) {
        db.characters = [];
    }
    const char = db.characters?.[index];
    return char;
}

/** `setCurrentCharacter` for the character at an index (the mirror's chats are kept the same way). */
export function setCharacterByIndex(index: number, char: character | groupChat) {
    if (!DBState.db.characters) {
        DBState.db.characters = [];
    }
    writeCharacterFieldsAt(index, char);
    markCharacterDirtyAt(index);
}

export function getCurrentChat() {
    const char = getCurrentCharacter();
    return char?.chats?.[char.chatPage];
}

export const saveImage = saveImageGlobal;

const defaultSdData: [string, string][] = [
    ["always", "solo, 1girl"],
    ["negative", ""],
    ["|character\'s appearance", ""],
    ["current situation", ""],
    ["$character's pose", ""],
    ["$character's emotion", ""],
    ["current location", ""],
];

export const defaultSdDataFunc = () => {
    return safeStructuredClone(defaultSdData);
};

/**
 * Copies the five keep-on-switch fields (`PRESET_KEEP_ON_SWITCH_FIELDS`, `providers` fields) into
 * the selected preset, as the pre-Phase 3 `saveCurrentPreset` did with the whole working copy. The
 * other preset fields need no saving: the forwarding layer writes them into the preset directly.
 */
export function saveCurrentPreset() {
    const db = DBState.db;
    const current = selectedPresetForWrite(db);
    if (!current) {
        return;
    }
    current.seperateModelsForAxModels = db.doNotChangeSeperateModels ? false : (db.seperateModelsForAxModels ?? false);
    current.seperateModels = db.doNotChangeSeperateModels ? null : plainClone(db.seperateModels);
    current.fallbackModels = plainClone(db.fallbackModels);
    current.fallbackWhenBlankResponse = db.fallbackWhenBlankResponse ?? false;
    current.seperateParameters = plainClone(db.seperateParameters);
}

/** Adds a copy of preset `id` (its `proxyKey` entry too) under a new id. */
export function copyPreset(id: string) {
    saveCurrentPreset();
    const db = DBState.db;
    const source = db.botPresets.find((preset) => preset.id === id);
    if (!source) {
        return;
    }
    const copy = plainClone(source);
    const copyId = newPresetId();
    db.botPresets.push(normalizePreset({ ...copy, name: `${copy.name} Copy` }, { id: copyId }));
    copyPresetSecret(id, copyId);
}

/**
 * Selects preset `id` for this client. The keep-on-switch fields travel as before Phase 3: the
 * current values are saved into the old preset (unless `savecurrent` is false) and the new preset's
 * values are copied into `providers`, honoring the three "keep on preset change" toggles.
 */
export function changeToPreset(id: string, savecurrent = true) {
    const db = DBState.db;
    const next = db.botPresets.find((preset) => preset.id === id);
    if (!next) {
        return;
    }
    if (savecurrent) {
        saveCurrentPreset();
    }
    selectPreset(id);
    setPreset(db, next);
}

/**
 * Copies `newPres`'s keep-on-switch fields into `providers` (in `db`), as the pre-Phase 3 `setPreset`
 * did, honoring `doNotChangeSeperateModels`, `doNotChangeFallbackModels`, and
 * `disableSeperateParameterChangeOnPresetChange`. The other preset fields are forwarded.
 */
export function setPreset(db: Database, newPres: Omit<botPreset, "id">) {
    if (!db.doNotChangeSeperateModels) {
        db.seperateModelsForAxModels = newPres.seperateModelsForAxModels ?? false;
        db.seperateModels = plainClone(newPres.seperateModels) ?? {
            memory: "",
            emotion: "",
            translate: "",
            otherAx: "",
        };
    }
    if (!db.doNotChangeFallbackModels) {
        db.fallbackModels = plainClone(newPres.fallbackModels) ?? {
            memory: [],
            emotion: [],
            translate: [],
            otherAx: [],
            model: [],
        };
        db.fallbackWhenBlankResponse = newPres.fallbackWhenBlankResponse ?? false;
    }
    if (!db.disableSeperateParameterChangeOnPresetChange) {
        db.seperateParameters = newPres.seperateParameters
            ? plainClone(newPres.seperateParameters)
            : {
                  memory: {},
                  emotion: {},
                  translate: {},
                  otherAx: {},
                  overrides: {},
              };
    }
    return db;
}

/**
 * Replaces the selected preset's settings with `template` (a prebuilt preset), keeping its id,
 * name, and image, and copies the template's keep-on-switch fields as a switch would.
 */
export function applyPresetTemplate(template: Omit<botPreset, "id">) {
    const db = DBState.db;
    const current = selectedPreset(db);
    if (!current) {
        return;
    }
    const index = db.botPresets.findIndex((preset) => preset.id === current.id);
    const applied = normalizePreset(
        { ...plainClone(template), name: current.name, image: current.image },
        { id: current.id },
    );
    db.botPresets[index] = applied;
    setPreset(db, applied);
}

import { encode as encodeMsgpack, decode as decodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decodeRPack, encodeRPack } from "../rpack/rpack_js";
import { DBState, selectedCharID } from "../stores.svelte";
import { addPreset } from "./collectionStore.svelte";

export async function downloadPreset(id: string, type: "json" | "risupreset" | "return" = "json") {
    saveCurrentPreset();
    const source = getDatabase().botPresets.find((preset) => preset.id === id);
    if (!source) {
        return;
    }
    let pres = plainClone(source);
    // Every canonical field is written, an unset one as an explicit `undefined`, as the pre-Phase 3
    // export did (the JSON copy drops them): an importer spreads `presetTemplate` under the file, so
    // an absent key would take the template's value instead (`promptPreprocess: false`).
    for (const field of PRESET_FIELDS) {
        if (!Object.hasOwn(pres, field)) {
            (pres as unknown as Record<string, unknown>)[field] = undefined;
        }
    }
    // The `.risup` format carries no id (D5); the credentials are blanked as before.
    delete pres.id;
    pres.openAIKey = "";
    pres.forceReplaceUrl = "";
    pres.forceReplaceUrl2 = "";
    pres.proxyKey = "";
    pres.textgenWebUIStreamURL = "";
    pres.textgenWebUIBlockingURL = "";

    if (type === "json") {
        downloadFile(pres.name + "_preset.json", Buffer.from(JSON.stringify(pres, null, 2)));
    } else if (type === "risupreset" || type === "return") {
        const buf = fflate.compressSync(
            encodeMsgpack({
                presetVersion: 2,
                type: "preset",
                preset: await encryptBuffer(encodeMsgpack(pres), "risupreset"),
            }),
        );

        const buf2 = await encodeRPack(buf);

        if (type === "risupreset") {
            downloadFile(pres.name + "_preset.risup", buf2);
        } else {
            return {
                data: pres,
                buf: buf2,
            };
        }
    }

    alertNormal(language.successExport);

    return {
        data: pres,
        buf: null,
    };
}

export async function importPreset(
    f: {
        name: string;
        data: Uint8Array;
    } | null = null,
) {
    if (!f) {
        f = await selectSingleFile(["json", "preset", "risupreset", "risup"]);
    }
    if (!f) {
        return;
    }
    let pre: any;
    if (f.name.endsWith(".risupreset") || f.name.endsWith(".risup")) {
        let data = f.data;
        if (f.name.endsWith(".risup")) {
            data = await decodeRPack(data);
        }
        const decoded = await decodeMsgpack(fflate.decompressSync(data));
        console.log(decoded);
        if ((decoded.presetVersion === 0 || decoded.presetVersion === 2) && decoded.type === "preset") {
            pre = {
                ...presetTemplate,
                ...decodeMsgpack(Buffer.from(await decryptBuffer(decoded.preset ?? decoded.pres, "risupreset"))),
            };
        }
    } else {
        pre = { ...presetTemplate, ...JSON.parse(Buffer.from(f.data).toString("utf-8")) };
        console.log(pre);
    }
    if (pre?.promptTemplate !== undefined) {
        pre.promptTemplate = normalizePromptTemplate(pre.promptTemplate);
    }
    if (pre.presetVersion && pre.presetVersion >= 3) {
        //NAI preset
        const pr = safeStructuredClone(prebuiltPresets.NAI);
        pr.temperature = pre.parameters.temperature * 100;
        pr.maxResponse = pre.parameters.max_length;
        pr.NAISettings.topK = pre.parameters.top_k;
        pr.NAISettings.topP = pre.parameters.top_p;
        pr.NAISettings.topA = pre.parameters.top_a;
        pr.NAISettings.typicalp = pre.parameters.typical_p;
        pr.NAISettings.tailFreeSampling = pre.parameters.tail_free_sampling;
        pr.NAISettings.repetitionPenalty = pre.parameters.repetition_penalty;
        pr.NAISettings.repetitionPenaltyRange = pre.parameters.repetition_penalty_range;
        pr.NAISettings.repetitionPenaltySlope = pre.parameters.repetition_penalty_slope;
        pr.NAISettings.frequencyPenalty = pre.parameters.repetition_penalty_frequency;
        pr.NAISettings.repostitionPenaltyPresence = pre.parameters.repetition_penalty_presence;
        pr.PresensePenalty = pre.parameters.repetition_penalty_presence * 100;
        pr.NAISettings.cfg_scale = pre.parameters.cfg_scale;
        pr.NAISettings.mirostat_lr = pre.parameters.mirostat_lr;
        pr.NAISettings.mirostat_tau = pre.parameters.mirostat_tau;
        pr.name = pre.name ?? "Imported";
        addPreset(normalizePreset(pr));
        return;
    }

    if (Array.isArray(pre?.prompt_order?.[0]?.order) && Array.isArray(pre?.prompts)) {
        //ST preset
        const pr = safeStructuredClone(presetTemplate);
        pr.promptTemplate = [];

        function findPrompt(identifier: number) {
            return pre.prompts.find((p: any) => p.identifier === identifier);
        }
        pr.temperature = (pre.temperature ?? 0.8) * 100;
        pr.frequencyPenalty = (pre.frequency_penalty ?? 0.7) * 100;
        pr.PresensePenalty = pre.presence_penalty * 0.7 * 100;
        pr.top_p = pre.top_p ?? 1;

        for (const prompt of pre.prompt_order[0].order) {
            if (!prompt?.enabled) {
                continue;
            }
            const p = findPrompt(prompt?.identifier ?? "");
            if (p) {
                switch (p.identifier) {
                    case "main": {
                        pr.promptTemplate.push({
                            type: "plain",
                            type2: "main",
                            text: p.content ?? "",
                            role: p.role ?? "system",
                        });
                        break;
                    }
                    case "jailbreak":
                    case "nsfw": {
                        pr.promptTemplate.push({
                            type: "jailbreak",
                            type2: "normal",
                            text: p.content ?? "",
                            role: p.role ?? "system",
                        });
                        break;
                    }
                    case "dialogueExamples":
                    case "charPersonality":
                    case "scenario": {
                        break; //ignore
                    }
                    case "chatHistory": {
                        pr.promptTemplate.push({
                            type: "chat",
                            rangeEnd: "end",
                            rangeStart: 0,
                        });
                        break;
                    }
                    case "worldInfoBefore": {
                        pr.promptTemplate.push({
                            type: "lorebook",
                        });
                        break;
                    }
                    case "worldInfoAfter": {
                        break;
                    }
                    case "charDescription": {
                        pr.promptTemplate.push({
                            type: "description",
                        });
                        break;
                    }
                    case "personaDescription": {
                        pr.promptTemplate.push({
                            type: "persona",
                        });
                        break;
                    }
                    default: {
                        console.log(p);
                        pr.promptTemplate.push({
                            type: "plain",
                            type2: "normal",
                            text: p.content ?? "",
                            role: p.role ?? "system",
                        });
                    }
                }
            } else {
                console.log("Prompt not found", prompt);
            }
        }
        if (pre?.assistant_prefill) {
            pr.promptTemplate.push({
                type: "postEverything",
            });
            pr.promptTemplate.push({
                type: "plain",
                type2: "main",
                text: `{{#if {{prefill_supported}}}}${pre?.assistant_prefill}{{/if}}`,
                role: "bot",
            });
        }
        pr.promptTemplate = normalizePromptTemplate(pr.promptTemplate);
        pr.name = "Imported ST Preset";
        addPreset(normalizePreset(pr));
        return;
    }
    pre.name ??= "Imported";
    // An imported preset always gets a fresh id, even when the file carries one (`addPreset`). A
    // `proxyKey` the file carries (a hand-written JSON; exports blank it) goes to the per-preset secret map.
    const proxyKey = typeof pre.proxyKey === "string" ? pre.proxyKey : "";
    // Normalized first, as before: a converted value the file lacks (a `NaN` from arithmetic on a
    // missing parameter) becomes the field's default instead of refusing the import.
    const id = addPreset(normalizePreset(pre));
    if (proxyKey !== "") {
        setPresetSecret(id, { proxyKey });
    }
}
