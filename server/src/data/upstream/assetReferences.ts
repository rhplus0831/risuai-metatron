import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import type { UpstreamAssetReference, UpstreamAssetRole } from "../../../../shared/upstreamBackup.ts";
import { isPlainObject } from "../../../../shared/valueKinds.ts";

/**
 * The `assets/...` keys a set of resource records references (`docs/plan/upstream-bin-compat.md` S4;
 * S6's export can reuse it): the server equivalent of the tab's backup inventory
 * (`src/ts/drive/backuplocal.ts` `referencedAssets`, `shared/backups.ts` `selectPartialBackupAssets`),
 * plus module assets and icons. Records are `{ kind, data }` as stored; every field is optional and
 * read defensively, since the normalizers do not check asset list shapes. One entry per key, its
 * first user, in record order. Values that are not `assets/` keys (`embeded://`, `ccdefault:`, data
 * URIs) are not assets.
 */
export function collectAssetReferences(records: Iterable<{ kind: string; data: unknown }>): UpstreamAssetReference[] {
    const found = new Map<string, UpstreamAssetReference>();
    const add = (key: unknown, owner: unknown, role: UpstreamAssetRole) => {
        if (typeof key === "string" && key.startsWith("assets/") && !found.has(key)) {
            found.set(key, { key, owner: typeof owner === "string" ? owner : "", role });
        }
    };
    const tuples = (list: unknown, owner: unknown, role: UpstreamAssetRole) => {
        if (Array.isArray(list)) {
            for (const entry of list) {
                if (Array.isArray(entry)) {
                    add(entry[1], owner, role);
                }
            }
        }
    };
    const module = (value: unknown) => {
        if (isPlainObject(value)) {
            add(value.icon, value.name, "module");
            tuples(value.assets, value.name, "module");
        }
    };
    const items = (data: unknown) => (Array.isArray(data) ? data.filter(isPlainObject) : []);
    for (const { kind, data } of records) {
        switch (kind) {
            case RESOURCE_KIND.characters: {
                if (!isPlainObject(data)) {
                    break;
                }
                const name = data.name;
                add(data.image, name, "profile");
                tuples(data.emotionImages, name, "emotion");
                tuples(data.additionalAssets, name, "additional");
                if (isPlainObject(data.vits) && isPlainObject(data.vits.files)) {
                    for (const value of Object.values(data.vits.files)) {
                        add(value, name, "vits");
                    }
                }
                for (const asset of items(data.ccAssets)) {
                    add(asset.uri, name, "ccAsset");
                }
                break;
            }
            case RESOURCE_KIND.personas:
                for (const persona of items(data)) {
                    add(persona.icon, persona.name, "persona");
                    module(persona.embeddedModule);
                }
                break;
            case RESOURCE_KIND.ui:
                if (isPlainObject(data)) {
                    add(data.customBackground, "", "background");
                }
                break;
            case RESOURCE_KIND.characterOrder:
                for (const folder of items(data)) {
                    add(folder.img, folder.name, "folder");
                    add(folder.imgFile, folder.name, "folder");
                }
                break;
            case RESOURCE_KIND.presets:
                for (const preset of items(data)) {
                    add(preset.image, preset.name, "preset");
                }
                break;
            case RESOURCE_KIND.modules:
                for (const entry of items(data)) {
                    module(entry);
                }
                break;
        }
    }
    return [...found.values()];
}
