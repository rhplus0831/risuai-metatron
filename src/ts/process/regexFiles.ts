import { settings } from "../storage/settingsViews.svelte";
import { language } from "src/lang";
import { alertError, alertNormal } from "../alert";
import { downloadFile } from "../globalApi.svelte";
import { type customscript } from "../storage/database.svelte";
import { selectSingleFile } from "../util";

/**
 * Regex script file import and export for the character, module, and preset editors. The shared
 * engine runs on the server through `server/src/scripts/worker.ts`; `edittrans` is applied in
 * the tab by `src/ts/translator/translator.ts`.
 */

/** Without an explicit list, exports the legacy `settings.globalscript`, which is not an execution source. */
export function exportRegex(s?: customscript[]) {
    const script = s ?? settings.globalscript;
    const data = Buffer.from(
        JSON.stringify({
            type: "regex",
            data: script,
        }),
        "utf-8",
    );
    downloadFile(`regexscript_export.json`, data);
    alertNormal(language.successExport);
}

/**
 * Appends a file's scripts to the supplied list in place and returns it (a new list if omitted).
 * A file without `{ type: "regex", data }` alerts and returns the list unchanged. The payload is
 * not validated as an array of scripts; parse or iteration failures alert through the same catch.
 */
export async function importRegex(o?: customscript[]): Promise<customscript[]> {
    o = o ?? [];
    const filedata = (await selectSingleFile(["json"])).data;
    if (!filedata) {
        return o;
    }
    try {
        const imported = JSON.parse(Buffer.from(filedata).toString("utf-8"));
        if (imported.type === "regex" && imported.data) {
            const datas: customscript[] = imported.data;
            const script = o;
            for (const data of datas) {
                script.push(data);
            }
            return o;
        } else {
            alertError("File invaid or corrupted");
        }
    } catch (error) {
        alertError(error);
    }
    return o;
}
