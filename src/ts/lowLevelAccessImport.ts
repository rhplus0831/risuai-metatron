import { language } from "src/lang";
import { alertSelect } from "./alert";

/**
 * The import question for content that asks for low-level access: a character card's
 * `extensions.risuai.lowLevelAccess` or a module's `lowLevelAccess`. The user imports it with the
 * access, imports it without (the flag is cleared, so the runtime refuses its low-level calls and
 * effects; the editor's checkbox can turn it on later), or cancels the import. Escape answers the
 * dialog with an empty value, which cancels.
 *
 * `holder` is the object that carries the flag, and the importer must build the stored record from
 * this same object afterwards. True when the import goes on: the holder does not ask, or the user
 * chose with or without the access.
 */
export async function confirmLowLevelAccessImport(
    holder: { lowLevelAccess?: boolean } | null | undefined,
): Promise<boolean> {
    if (!holder?.lowLevelAccess) {
        return true;
    }
    const answer = await alertSelect(
        [language.lowLevelAccessImportWith, language.lowLevelAccessImportWithout, language.cancel],
        language.lowLevelAccessImportQuestion,
    );
    if (answer === "1") {
        holder.lowLevelAccess = false;
    }
    return answer === "0" || answer === "1";
}
