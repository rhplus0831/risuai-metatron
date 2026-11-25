/**
 * Creative Commons display metadata for src/lib/UI/Realm/RealmLicense.svelte. Tuple positions
 * supply the CC 4.0 URL slug, tooltip requirements and displayed label. The `private` entry uses
 * the BY-NC-ND link with an additional private-prompts label; it has no separate license URL.
 */

/** License id to [CC URL slug, requirements, label], read by `src/lib/UI/Realm/RealmLicense.svelte`. */
export const CCLicenseData = {
    "CC BY 4.0": ["by", "Requires Attribution", "CC BY 4.0"],
    "CC BY-NC 4.0": ["by-nc", "Requires Attribution and Non Commercial", "CC BY-NC 4.0"],
    "CC BY-NC-SA 4.0": ["by-nc-sa", "Requires Attribution, Non Commercial and Share Alike", "CC BY-NC-SA 4.0"],
    "CC BY-SA 4.0": ["by-sa", "Requires Attribution and Share Alike", "CC BY-SA 4.0"],
    "CC BY-ND 4.0": ["by-nd", "Requires Attribution and No Derivatives", "CC BY-ND 4.0"],
    "CC BY-NC-ND 4.0": ["by-nc-nd", "Requires Attribution, Non Commercial and No Derivatives", "CC BY-NC-ND 4.0"],
    private: [
        "by-nc-nd",
        "Requires Attribution, Non Commercial and No Derivatives + Private Prompts",
        "CC BY-NC-ND 4.0 + Private",
    ],
};
