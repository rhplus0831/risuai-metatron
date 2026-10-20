import { untrack } from "svelte";
import type { RisuModule } from "./process/modules";
import {
    characterFieldPlain,
    isFrozenAssetList,
    isRecordWrapper,
    moduleFieldPlain,
    wrapperFieldStamp,
} from "./storage/records.svelte";

type AssetList = readonly (readonly [string, string, string])[];

const characterNames = new WeakMap<AssetList, { stamp: number; names: readonly string[] }>();
const moduleNames = new WeakMap<AssetList, readonly string[]>();
const frozenNames = new WeakMap<AssetList, readonly string[]>();

/**
 * Shared by the character editor and sticker picker. Never subscribes to individual names. A record's
 * frozen list (immutable) keeps its names by identity; a wrapper of a list of another shape by stamp.
 */
export function characterAssetNames(chaId: string, assets: AssetList): readonly string[] {
    return untrack(() => {
        if (isFrozenAssetList(assets)) {
            const known = frozenNames.get(assets);
            if (known) return known;
            const names = assets.map((asset) => asset[0].toLowerCase());
            frozenNames.set(assets, names);
            return names;
        }
        const stamp = wrapperFieldStamp(assets);
        const cached = characterNames.get(assets);
        if (stamp !== null && cached?.stamp === stamp) {
            return cached.names;
        }
        const plain = isRecordWrapper(assets) ? characterFieldPlain<AssetList>(chaId, "additionalAssets") : assets;
        const names = (plain ?? []).map((asset) => asset[0].toLowerCase());
        if (stamp !== null) {
            characterNames.set(assets, { stamp, names });
        }
        return names;
    });
}

/** The plain field copy is shared and read-only; only our separate name array is lowercased. */
export function moduleAssetNames(module: Pick<RisuModule, "assets">): readonly string[] {
    return untrack(() => {
        const assets = moduleFieldPlain(module, "assets");
        if (!assets) return [];
        const cached = moduleNames.get(assets);
        if (cached) return cached;
        const names = assets.map((asset) => asset[0].toLowerCase());
        moduleNames.set(assets, names);
        return names;
    });
}

/** Source indices in list order. Names must be lowercased; the nonempty query lowercased and trimmed. */
export function matchingAssetIndices(names: readonly string[], query: string): number[] {
    const indices: number[] = [];
    for (let index = 0; index < names.length; index++) {
        if (names[index].includes(query)) indices.push(index);
    }
    return indices;
}
