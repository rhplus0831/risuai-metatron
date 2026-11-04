import { language } from "src/lang";
import type { StructuredMemoryResult } from "src/ts/process/structuredMemory.svelte";

/**
 * Stored codes can outlive this tab's vocabulary. Unknown codes stay visible as themselves, so a
 * new server reason never becomes an empty row. This module supplies text only; callers own notices
 * and suppress duplicate epoch alerts raised by src/ts/storage/resourceClient.ts.
 */

/** A stored code's text from `table`; the code itself for one this tab does not know. */
export function codeText(table: Record<string, string>, code: string): string {
    return Object.hasOwn(table, code) ? table[code] : code;
}

/** The text of a stored reason code, of whichever kind; the code itself for one this tab does not know. */
export function memoryReasonText(code: string | undefined): string {
    if (code === undefined) {
        return "";
    }
    const { coverage, failureReasons, notAutomaticReasons } = language.structuredMemory;
    const tables = [coverage.reasons, failureReasons, notAutomaticReasons, language.memoryTasks.reasons];
    return tables.find((table) => Object.hasOwn(table, code))?.[code] ?? code;
}

/** The line a read that did not answer shows in place of its rows. */
export function memoryReadFailureText(result: Exclude<StructuredMemoryResult<never>, { outcome: "ok" }>): string {
    const { readRefused, readFailed } = language.structuredMemory.panel;
    return result.outcome === "refused" ? readRefused[result.reason] : readFailed(result.error);
}
