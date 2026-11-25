import { describe, expect, it } from "vitest";
import { pluginCompletionQuietMs, type RisuPlugin } from "./plugins.ts";

const plugin = (fields: Record<string, unknown> = {}): RisuPlugin =>
    ({
        name: "quiet-plugin",
        script: "",
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        ...fields,
    }) as RisuPlugin;

describe("pluginCompletionQuietMs", () => {
    it("waits only for an explicitly enabled completion switch", () => {
        expect(pluginCompletionQuietMs(undefined)).toBeNull();
        expect(pluginCompletionQuietMs(null)).toBeNull();
        for (const completionWait of [undefined, false, 1, "true"]) {
            expect(pluginCompletionQuietMs(plugin({ completionWait, completionQuietSeconds: 5 }))).toBeNull();
        }
        expect(pluginCompletionQuietMs(plugin({ completionWait: true, completionQuietSeconds: 5 }))).toBe(5000);
    });

    it("defaults missing, non-finite, and non-number quiet seconds to three seconds", () => {
        expect(pluginCompletionQuietMs(plugin({ completionWait: true }))).toBe(3000);
        for (const completionQuietSeconds of [NaN, Infinity, -Infinity, "8", null]) {
            expect(pluginCompletionQuietMs(plugin({ completionWait: true, completionQuietSeconds }))).toBe(3000);
        }
    });

    it("floors quiet seconds and clamps them to one through sixty before converting to milliseconds", () => {
        for (const [completionQuietSeconds, expected] of [
            [-2, 1000],
            [75, 60000],
            [4.9, 4000],
        ]) {
            expect(pluginCompletionQuietMs(plugin({ completionWait: true, completionQuietSeconds }))).toBe(expected);
        }
    });
});
