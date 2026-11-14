import { language } from "src/lang";

/** The `alertSelect` answers of the low-level access import question (`confirmLowLevelAccessImport`). */
export const lowLevelAccessAnswer = { with: "0", without: "1", cancel: "2", escape: "" } as const;

/** The arguments `confirmLowLevelAccessImport` passes to `alertSelect`: the buttons, then the question. */
export function lowLevelAccessDialog(): [string[], string] {
    return [
        [language.lowLevelAccessImportWith, language.lowLevelAccessImportWithout, language.cancel],
        language.lowLevelAccessImportQuestion,
    ];
}
