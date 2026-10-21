import { SECTION_KIND } from "../../../../shared/sections.ts";
import type { SettingContext, SettingItem } from "../../setting/types";
import { prototypeRoot } from "./prototypeRoot.svelte";

// Test-only: the settings registry's resolution as it was before it read the settings record views,
// for the prototype binding suites (`forwardingBindings.test.ts`, `projectionBindings.test.ts`) whose
// candidate is a prototype layer installed as `prototypeRoot.db`. The real
// `getSettingValue`/`setSettingValue` (`src/ts/setting/utils.ts`) resolve `bindKey` and `bindPath`'s
// first segment through the settings record views, which read the real records, so they never reach
// a prototype. This copy does what they did over the whole-database aggregate:
// `prototypeRoot.db[bindKey]`, the `bindPath` walk from `prototypeRoot.db` with `??=` containers, then
// `onChange`. Item callbacks run as in the real registry (`getValue(ctx)`, `setValue(value, ctx)`);
// `candidateContext()` gives them the candidate.

/**
 * A settings context over the candidate: every `settings.<section>` is `prototypeRoot.db` (the candidate
 * serves the section fields at its root, as the database did), so an item callback reading
 * `ctx.settings.ui.customQuotesData` reads what `db.customQuotesData` read over the aggregate. No
 * prototype item reads the preset or persona views.
 */
export function candidateContext(): SettingContext {
    const root = prototypeRoot.db;
    const settings = Object.fromEntries(Object.values(SECTION_KIND).map((section) => [section, root]));
    return {
        settings,
        preset: undefined,
        persona: undefined,
        modelInfo: undefined,
        subModelInfo: undefined,
    } as unknown as SettingContext;
}

/** `getSettingValue` as it resolved over the aggregate, over `prototypeRoot.db`. */
export function candidateGetSettingValue(item: SettingItem, ctx: SettingContext): any {
    if (item.getValue) {
        return item.getValue(ctx);
    }
    if (item.bindPath) {
        let value: any = prototypeRoot.db;
        for (const part of item.bindPath.split(".")) {
            value = value?.[part];
        }
        return value;
    }
    if (item.bindKey) {
        return (prototypeRoot.db as any)[item.bindKey];
    }
    return undefined;
}

/** `setSettingValue` as it resolved over the aggregate, over `prototypeRoot.db`. */
export function candidateSetSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): void {
    if (item.setValue) {
        item.setValue(newValue, ctx);
    } else if (item.bindPath) {
        const parts = item.bindPath.split(".");
        let obj: any = prototypeRoot.db;
        for (let i = 0; i < parts.length - 1; i++) {
            obj = obj[parts[i]] ??= {};
        }
        obj[parts[parts.length - 1]] = newValue;
    } else if (item.bindKey) {
        (prototypeRoot.db as any)[item.bindKey] = newValue;
    }

    if (item.onChange) {
        item.onChange(newValue, ctx);
    }
}
