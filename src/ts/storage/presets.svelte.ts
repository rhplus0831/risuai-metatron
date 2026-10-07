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
    normalizeModelPreset,
    normalizePreset,
    normalizePromptTemplate,
    plainClone,
    PRESET_RECORD_FIELDS,
    presetTemplate,
    PROMPT_PRESET_FIELDS,
} from "../../../shared/presets.ts";
import type { botPreset } from "../../../shared/database.ts";
import { safeStructuredClone } from "../polyfill";
import { addPreset } from "./collectionStore.svelte";
import { copyModelPresetSecret, deleteModelPresetSecret } from "./llmSecrets.svelte";
import { selectModelPreset, selectPreset, selection } from "./selection.svelte";
import { currentPresetRecord, settings } from "./settingsViews.svelte";

/*
 * The preset actions of the preset lists and the welcome screen (Phase 6 slice 10, out of
 * `database.svelte.ts`; split into prompt and model presets by `docs/plan/split-preset.md`): copy,
 * switch, apply a template, export, and import, over the `presets` record (prompt presets) and the
 * `modelPresets` collection (`settingsViews.svelte.ts`). Every preset field lives in its own preset
 * (the views write them there directly), so a switch only changes this tab's selection.
 */

/** Adds a copy of prompt preset `id` under a new id. */
export function copyPreset(id: string) {
    const presets = settings.presets;
    const source = presets.find((preset) => preset.id === id);
    if (!source) {
        return;
    }
    const copy = plainClone(source);
    presets.push(normalizePreset({ ...copy, name: `${copy.name} Copy` }, { id: newPresetId() }));
}

/** Selects prompt preset `id` for this client (nothing else changes: the model preset is its own). */
export function changeToPreset(id: string) {
    if (settings.presets.some((preset) => preset.id === id)) {
        selectPreset(id);
    }
}

/** Selects model preset `id` for this client. */
export function changeToModelPreset(id: string) {
    if (settings.modelPresets?.some((preset) => preset.id === id)) {
        selectModelPreset(id);
    }
}

/** Adds a copy of model preset `id` (its `proxyKey` entry too) under a new id. Returns the new id. */
export function copyModelPreset(id: string): string | undefined {
    const presets = settings.modelPresets;
    const source = presets?.find((preset) => preset.id === id);
    if (!presets || !source) {
        return undefined;
    }
    const copy = plainClone(source);
    const copyId = newPresetId();
    presets.push(normalizeModelPreset({ ...copy, name: `${copy.name} Copy` }, { id: copyId }));
    copyModelPresetSecret(id, copyId);
    return copyId;
}

/**
 * Removes model preset `id` and its `proxyKey` entry. The last model preset is never removed (a
 * selection always needs a record; returns `false`). Removing the selected one selects the first
 * remaining one, as deleting the selected prompt preset does.
 */
export function removeModelPreset(id: string): boolean {
    const presets = settings.modelPresets;
    const index = presets?.findIndex((preset) => preset.id === id) ?? -1;
    if (!presets || index === -1 || presets.length <= 1) {
        return false;
    }
    presets.splice(index, 1);
    const next = presets[0];
    if (next && !presets.some((preset) => preset.id === selection.modelPresetId)) {
        selectModelPreset(next.id);
    }
    deleteModelPresetSecret(id);
    return true;
}

/**
 * Replaces the selected prompt preset's settings with `template` (a prebuilt preset), keeping its
 * id, name, and image. The template's model fields are not applied (`normalizePreset` drops them).
 */
export function applyPresetTemplate(template: Omit<botPreset, "id">) {
    const current = currentPresetRecord();
    if (!current) {
        return;
    }
    const presets = settings.presets;
    const index = presets.findIndex((preset) => preset.id === current.id);
    presets[index] = normalizePreset(
        { ...plainClone(template), name: current.name, image: current.image },
        { id: current.id },
    );
}

export async function downloadPreset(id: string, type: "json" | "risupreset" | "return" = "json") {
    const source = settings.presets.find((preset) => preset.id === id);
    if (!source) {
        return;
    }
    const stored = plainClone(source) as unknown as Record<string, unknown>;
    // A prompt preset file (`docs/plan/split-preset.md`): `name`, `image`, and every prompt field,
    // an unset one as an explicit `undefined`, as the pre-Phase 3 export did (the JSON copy drops
    // them): an importer spreads `presetTemplate` under the file, so an absent key would take the
    // template's value instead (`promptPreprocess: false`). No id (D5), no model field, no credential.
    const pres: Record<string, unknown> = {};
    for (const field of [...PRESET_RECORD_FIELDS, ...PROMPT_PRESET_FIELDS]) {
        pres[field] = stored[field];
    }
    const fileName = typeof pres.name === "string" ? pres.name : "";

    if (type === "json") {
        downloadFile(fileName + "_preset.json", Buffer.from(JSON.stringify(pres, null, 2)));
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
            downloadFile(fileName + "_preset.risup", buf2);
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
    // An imported preset always gets a fresh id, even when the file carries one (`addPreset`). It is
    // a prompt preset: the model fields and a `proxyKey` the file carries are ignored
    // (`docs/plan/split-preset.md`). Normalized first, as before: a converted value the file lacks (a
    // `NaN` from arithmetic on a missing parameter) becomes the field's default instead of refusing
    // the import.
    addPreset(normalizePreset(pre));
}
