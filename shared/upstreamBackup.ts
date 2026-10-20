/**
 * The report of an upstream RisuAI `.bin` import (`docs/plan/upstream-bin-compat.md`): what the
 * converter (`server/src/data/upstream/importDatabase.ts`) kept, converted, or left out, shown to
 * the user before the import replaces anything. Codes are stable strings the client maps to
 * `language.*` text; an entry's `examples` are names (presets, fields, models), never values.
 */

/** Data the converter carried over in another shape. */
export const UPSTREAM_CONVERTED_CODES = [
    /** A reverse proxy key (`proxyKey`) became a named key, bound by the profiles that use the proxy. */
    "proxy-key-to-credential",
    /** A preset's own OpenAI key, which upstream no longer reads, became an unbound named key. */
    "preset-openai-key-to-credential",
    /** A custom model's key became a named key, bound by the profiles that use that model. */
    "custom-model-key-to-credential",
] as const;

/** Data the converter did not import. */
export const UPSTREAM_EXCLUDED_CODES = [
    /** A root setting metatron does not know; the examples are field names. */
    "unknown-setting",
    /** The Risu Account login (`account`). */
    "risu-account",
    /** Saved loadouts (`loadouts`, `lastLoadedLoadoutName`). */
    "loadouts",
    /** A setting of a feature metatron removed, with a value set; the examples are field names. */
    "removed-feature",
    /** A setting or list entry the converter could not make valid; the examples are field paths. */
    "invalid-setting",
    /** A custom model with invalid required fields or rejected serialized data; examples are names or positions. */
    "invalid-custom-model",
] as const;

export type UpstreamConvertedCode = (typeof UPSTREAM_CONVERTED_CODES)[number];
export type UpstreamExcludedCode = (typeof UPSTREAM_EXCLUDED_CODES)[number];

/** How many names an entry lists; `count` still counts every occurrence. */
export const UPSTREAM_REPORT_EXAMPLE_LIMIT = 5;

export type UpstreamReportEntry<Code extends string = string> = {
    code: Code;
    /** Source occurrences of this conversion or exclusion, independent of credential deduplication. */
    count: number;
    examples: string[];
};

/** How many records of each category the converter produced. */
export type UpstreamImportCounts = {
    promptPresets: number;
    modelPresets: number;
    /** Converted profiles, without the materialized `default` profile. */
    modelProfiles: number;
    credentials: number;
    personas: number;
    customModels: number;
};

export type UpstreamImportReport = {
    counts: UpstreamImportCounts;
    converted: UpstreamReportEntry<UpstreamConvertedCode>[];
    excluded: UpstreamReportEntry<UpstreamExcludedCode>[];
};

/** The records the tab selects after the import (D4): the upstream-selected preset and persona. */
export type UpstreamImportSelection = {
    promptPresetId: string;
    modelPresetId: string;
    personaId: string;
};

export function createUpstreamImportReport(): UpstreamImportReport {
    return {
        counts: { promptPresets: 0, modelPresets: 0, modelProfiles: 0, credentials: 0, personas: 0, customModels: 0 },
        converted: [],
        excluded: [],
    };
}

/**
 * Counts one occurrence of `code` in `list` (one entry per code, in first-occurrence order) and
 * records `example` while the entry lists fewer than `UPSTREAM_REPORT_EXAMPLE_LIMIT` names and
 * does not list it yet.
 */
export function addUpstreamReportEntry<Code extends string>(
    list: UpstreamReportEntry<Code>[],
    code: Code,
    example?: string,
): void {
    let entry = list.find((candidate) => candidate.code === code);
    if (!entry) {
        entry = { code, count: 0, examples: [] };
        list.push(entry);
    }
    entry.count += 1;
    if (
        example !== undefined &&
        entry.examples.length < UPSTREAM_REPORT_EXAMPLE_LIMIT &&
        !entry.examples.includes(example)
    ) {
        entry.examples.push(example);
    }
}
