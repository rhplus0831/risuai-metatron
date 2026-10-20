import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import type { UpstreamAssetReference, UpstreamAssetRole } from "../../../../shared/upstreamBackup.ts";
import { isPlainObject } from "../../../../shared/valueKinds.ts";

/**
 * The asset walk of both `.bin` directions (`docs/plan/upstream-bin-compat.md` S4 import, S6 export):
 * one walker over an upstream flat `Database`, and an adapter that gives it the stored records in that
 * shape. The server equivalent of the tab's backup inventory (`src/ts/drive/backuplocal.ts`
 * `referencedAssets`, `shared/backups.ts` `selectPartialBackupAssets`; U `globalApi.svelte.ts` lists
 * the same), plus module assets and icons.
 */

/**
 * Every `assets/...` key an upstream `Database` references, once, with the first owner and role that
 * names it, in this order: character and group images, emotions, additional assets, VITS files, card
 * assets (`ccAssets` `uri`), the GPT-SoVITS reference audio, the user icon and background, persona
 * icons and embedded modules, folder images (`img`, `imgFile`), preset images, and module assets and
 * icons. Every field is optional and read defensively, since neither the store's normalizers nor
 * upstream check asset list shapes. Values that are not `assets/` keys (`embeded://`, `ccdefault:`,
 * data URIs, URLs) are not assets.
 */
export function collectUpstreamAssetReferences(db: Readonly<Record<string, unknown>>): UpstreamAssetReference[] {
    const found = new Map<string, UpstreamAssetReference>();
    const add = (key: unknown, owner: unknown, role: UpstreamAssetRole) => {
        if (typeof key === "string" && key.startsWith("assets/") && !found.has(key)) {
            found.set(key, { key, owner: typeof owner === "string" ? owner : "", role });
        }
    };
    const tuples = (list: unknown, owner: unknown, role: UpstreamAssetRole) => {
        for (const entry of items(list)) {
            if (Array.isArray(entry)) {
                add(entry[1], owner, role);
            }
        }
    };
    const module = (value: unknown, owner: unknown) => {
        if (isPlainObject(value)) {
            tuples(value.assets, owner, "module");
            add(value.icon, owner, "moduleIcon");
        }
    };
    for (const entry of objects(db.characters)) {
        const owner = entry.name;
        add(entry.image, owner, "profile");
        tuples(entry.emotionImages, owner, "emotion");
        tuples(entry.additionalAssets, owner, "additional");
        if (isPlainObject(entry.vits) && isPlainObject(entry.vits.files)) {
            for (const file of Object.values(entry.vits.files)) {
                add(file, owner, "vits");
            }
        }
        for (const asset of objects(entry.ccAssets)) {
            add(asset.uri, owner, "ccAsset");
        }
        const sovits = entry.gptSoVitsConfig;
        if (isPlainObject(sovits) && isPlainObject(sovits.ref_audio_data)) {
            add(sovits.ref_audio_data.assetId, owner, "sovitsReference");
        }
    }
    add(db.userIcon, "", "userIcon");
    add(db.customBackground, "", "background");
    for (const persona of objects(db.personas)) {
        add(persona.icon, persona.name, "persona");
        module(persona.embeddedModule, persona.name);
    }
    for (const folder of objects(db.characterOrder)) {
        add(folder.img, folder.name, "folder");
        add(folder.imgFile, folder.name, "folder");
    }
    for (const preset of objects(db.botPresets)) {
        add(preset.image, preset.name, "preset");
    }
    for (const entry of objects(db.modules)) {
        module(entry, entry.name);
    }
    return [...found.values()];
}

/**
 * The asset references of stored resource records (`{ kind, data }`, as the import converter emits
 * them): the records placed where an upstream `Database` holds them (`characters` records into
 * `characters`, `presets` into `botPresets`, the `ui` section's `customBackground`, the `personas`,
 * `characterOrder`, and `modules` lists) and walked by `collectUpstreamAssetReferences`. Other kinds
 * reference no asset; metatron keeps the user icon on the persona.
 */
export function collectAssetReferences(records: Iterable<{ kind: string; data: unknown }>): UpstreamAssetReference[] {
    const characters: unknown[] = [];
    const db: Record<string, unknown> = { characters };
    for (const { kind, data } of records) {
        switch (kind) {
            case RESOURCE_KIND.characters:
                characters.push(data);
                break;
            case RESOURCE_KIND.ui:
                if (isPlainObject(data)) {
                    db.customBackground = data.customBackground;
                }
                break;
            case RESOURCE_KIND.personas:
            case RESOURCE_KIND.characterOrder:
            case RESOURCE_KIND.modules:
                db[kind] = data;
                break;
            case RESOURCE_KIND.presets:
                db.botPresets = data;
                break;
        }
    }
    return collectUpstreamAssetReferences(db);
}

function items(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function objects(value: unknown): Record<string, unknown>[] {
    return items(value).filter(isPlainObject);
}
