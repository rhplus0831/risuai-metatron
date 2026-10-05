import { settings } from "../storage/settingsViews.svelte";
import { language } from "src/lang";
import { alertError, alertNormal } from "../alert";
import { downloadFile } from "../globalApi.svelte";
import { type customscript } from "../storage/database.svelte";
import { selectSingleFile } from "../util";

// The regex script file export and import of the editors (character, module, global regex). The
// regex scripts themselves run on the server (`/api/transform` and the generation job, Phase 5).

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
