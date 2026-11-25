import { alertRealmTerms } from "./alert";
import { settings } from "./storage/settingsViews.svelte";

/**
 * The version of the RisuRealm terms notice. RisuRealm is RisuAI's service, so its Terms of Service
 * and Privacy Policy apply to using it; this app itself is not RisuAI's. A new version asks again.
 */
export const REALM_TERMS_VERSION = "2026-10-26";
/** RisuAI's service terms, shown with the privacy policy by `src/ts/alert.ts` `alertRealmTerms`. */
export const REALM_TERMS_URL = "https://account.sionyw.com/terms";
/** RisuAI's privacy policy; acceptance is versioned together with the service terms. */
export const REALM_PRIVACY_URL = "https://account.sionyw.com/privacy";

let asking: Promise<boolean> | null = null;

/**
 * Resolves true once the user has accepted the current RisuRealm terms: at once when the settings
 * already hold this version, otherwise after the terms dialog, whose Accept stores the version in
 * `ui.realmTermsAccepted` (every device of this server shares it). Concurrent callers share one
 * dialog. Callers send no request to Realm (through `/hub-proxy` or the server's Realm import)
 * before it resolves true.
 */
export function ensureRealmTerms(): Promise<boolean> {
    if (settings.ui.realmTermsAccepted === REALM_TERMS_VERSION) {
        return Promise.resolve(true);
    }
    asking ??= alertRealmTerms()
        .then((accepted) => {
            if (accepted) {
                settings.ui.realmTermsAccepted = REALM_TERMS_VERSION;
            }
            return accepted;
        })
        .finally(() => {
            asking = null;
        });
    return asking;
}
