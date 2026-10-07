import { SECTION_KIND } from "../../../../shared/sections.ts";
import type { SettingContext, SettingItem } from "../../setting/types";
import { spikeRoot } from "./spikeRoot.svelte";

// Test-only: the settings registry's resolution as it was before Phase 6 slice 6, for the binding
// spikes (`forwardingSpike.test.ts`, `projectionSpike.test.ts`) whose candidate is a prototype layer
// installed as `spikeRoot.db`. The real `getSettingValue`/`setSettingValue` (`src/ts/setting/utils.ts`)
// resolve `bindKey` and `bindPath`'s first segment through the settings record views since slice 6,
// which read the real records, so they no longer reach a prototype. This copy does what they did:
// `spikeRoot.db[bindKey]`, the `bindPath` walk from `spikeRoot.db` with `??=` containers, then
// `onChange`. Item callbacks run as in the real registry (`getValue(ctx)`, `setValue(value, ctx)`);
// `candidateContext()` gives them the candidate.

/**
 * A settings context over the candidate: every `settings.<section>` is `spikeRoot.db` (the candidate
 * serves the section fields at its root, as the database did), so an item callback reading
 * `ctx.settings.ui.customQuotesData` reads what `db.customQuotesData` read before slice 6. No spike
 * item reads the preset or persona views.
 */
export function candidateContext(): SettingContext {
    const root = spikeRoot.db;
    const settings = Object.fromEntries(Object.values(SECTION_KIND).map((section) => [section, root]));
    return {
        settings,
        preset: undefined,
        persona: undefined,
        modelInfo: undefined,
        subModelInfo: undefined,
    } as unknown as SettingContext;
}

/** `getSettingValue` before slice 6, over `spikeRoot.db`. */
export function candidateGetSettingValue(item: SettingItem, ctx: SettingContext): any {
    if (item.getValue) {
        return item.getValue(ctx);
    }
    if (item.bindPath) {
        let value: any = spikeRoot.db;
        for (const part of item.bindPath.split(".")) {
            value = value?.[part];
        }
        return value;
    }
    if (item.bindKey) {
        return (spikeRoot.db as any)[item.bindKey];
    }
    return undefined;
}

/** `setSettingValue` before slice 6, over `spikeRoot.db`. */
export function candidateSetSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): void {
    if (item.setValue) {
        item.setValue(newValue, ctx);
    } else if (item.bindPath) {
        const parts = item.bindPath.split(".");
        let obj: any = spikeRoot.db;
        for (let i = 0; i < parts.length - 1; i++) {
            obj = obj[parts[i]] ??= {};
        }
        obj[parts[parts.length - 1]] = newValue;
    } else if (item.bindKey) {
        (spikeRoot.db as any)[item.bindKey] = newValue;
    }

    if (item.onChange) {
        item.onChange(newValue, ctx);
    }
}
