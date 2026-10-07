import { language } from "../../lang";
import { encode as encodeMsgpack, decode as decodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decodeRPack, encodeRPack } from "../rpack/rpack_js";
import { decryptBuffer, encryptBuffer, selectSingleFile } from "../util";
import { downloadFile } from "../globalApi.svelte";
import { alertNormal } from "../alert";
import { prebuiltPresets } from "../process/templates/templates";
import {
    newPresetId,
    normalizePreset,
    normalizePromptTemplate,
    plainClone,
    PRESET_FIELDS,
    presetTemplate,
} from "../../../shared/presets.ts";
import type { botPreset } from "../../../shared/database.ts";
import { safeStructuredClone } from "../polyfill";
import { addPreset } from "./collectionStore.svelte";
import { copyPresetSecret, setSecret } from "./llmSecrets.svelte";
import { batchRecordWrites } from "./records.svelte";
import { selectPreset } from "./selection.svelte";
import { currentPresetRecord, presetRecordForWrite, settings } from "./settingsViews.svelte";

/*
 * The preset actions of the preset list and the welcome screen (Phase 6 slice 10, out of
 * `database.svelte.ts`): save, copy, switch, apply a template, export, and import, over the
 * `presets` record and the `providers` section (`settingsViews.svelte.ts`). Each writes in one
 * `batchRecordWrites` scope, so every record it changes is queued once.
 */

/**
 * Copies the five keep-on-switch fields (`PRESET_KEEP_ON_SWITCH_FIELDS`, `providers` fields) into
 * the selected preset, as the pre-Phase 3 `saveCurrentPreset` did with the whole working copy. The
 * other preset fields need no saving: `activePreset` writes them into the preset directly.
 */
export function saveCurrentPreset() {
    batchRecordWrites(saveCurrentPresetFields);
}

function saveCurrentPresetFields() {
    const current = presetRecordForWrite();
    if (!current) {
        return;
    }
    const providers = settings.providers;
    current.seperateModelsForAxModels = providers.doNotChangeSeperateModels
        ? false
        : (providers.seperateModelsForAxModels ?? false);
    current.seperateModels = providers.doNotChangeSeperateModels ? null : plainClone(providers.seperateModels);
    current.fallbackModels = plainClone(providers.fallbackModels);
    current.fallbackWhenBlankResponse = providers.fallbackWhenBlankResponse ?? false;
    current.seperateParameters = plainClone(providers.seperateParameters);
}

/** Adds a copy of preset `id` (its `proxyKey` entry too) under a new id. */
export function copyPreset(id: string) {
    saveCurrentPreset();
    const presets = settings.presets;
    const source = presets.find((preset) => preset.id === id);
    if (!source) {
        return;
    }
    const copy = plainClone(source);
    const copyId = newPresetId();
    presets.push(normalizePreset({ ...copy, name: `${copy.name} Copy` }, { id: copyId }));
    copyPresetSecret(id, copyId);
}

/**
 * Selects preset `id` for this client. The keep-on-switch fields travel as before Phase 3: the
 * current values are saved into the old preset (unless `savecurrent` is false) and the new preset's
 * values are copied into `providers`, honoring the three "keep on preset change" toggles.
 */
export function changeToPreset(id: string, savecurrent = true) {
    const next = settings.presets.find((preset) => preset.id === id);
    if (!next) {
        return;
    }
    // One queued write per record it changes (the old preset, `providers`).
    batchRecordWrites(() => {
        if (savecurrent) {
            saveCurrentPreset();
        }
        selectPreset(id);
        copyKeepOnSwitchFields(next);
    });
}

/**
 * Copies `newPres`'s keep-on-switch fields into `providers`, as the pre-Phase 3 `setPreset` did,
 * honoring `doNotChangeSeperateModels`, `doNotChangeFallbackModels`, and
 * `disableSeperateParameterChangeOnPresetChange`. The other preset fields are the preset's own.
 */
function copyKeepOnSwitchFields(newPres: Omit<botPreset, "id">) {
    const db = settings.providers;
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
}

/**
 * Replaces the selected preset's settings with `template` (a prebuilt preset), keeping its id,
 * name, and image, and copies the template's keep-on-switch fields as a switch would.
 */
export function applyPresetTemplate(template: Omit<botPreset, "id">) {
    const current = currentPresetRecord();
    if (!current) {
        return;
    }
    const presets = settings.presets;
    const index = presets.findIndex((preset) => preset.id === current.id);
    const applied = normalizePreset(
        { ...plainClone(template), name: current.name, image: current.image },
        { id: current.id },
    );
    batchRecordWrites(() => {
        presets[index] = applied;
        copyKeepOnSwitchFields(applied);
    });
}

export async function downloadPreset(id: string, type: "json" | "risupreset" | "return" = "json") {
    saveCurrentPreset();
    const source = settings.presets.find((preset) => preset.id === id);
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
        setSecret({ kind: "entry", field: "presets", id }, proxyKey);
    }
}
