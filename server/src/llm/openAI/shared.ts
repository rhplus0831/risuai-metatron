import { isLocalNetworkUrl } from "../../../../shared/localNetwork.ts";
import { credentialSlotOf } from "../../../../shared/llm/credentialSlots.ts";
import { defaultCredentialKey } from "../credentials.ts";
import type { RequestDataArgumentExtended } from "../request.ts";
import type { RequestDb } from "../settings.ts";

/**
 * Credential selection and local-network transport options shared by server/src/llm/openAI/requests.ts and
 * server/src/llm/openAI/responses.ts. Key selection stays within the model's credential slot; local routing requires
 * both the resolved profile's opt-in and a local-network URL. Only streaming local requests receive this module's
 * timeout override, leaving buffered requests to the transport's default deadline.
 */

/**
 * A provider-specific key never falls through to another provider's default, even on direct calls. The key is
 * `arg.key` (a bound named key), else a `keyIdentifier` model's own `OaiCompAPIKeys` entry or `""`, else the provider
 * default (`""` for a custom model or the reverse proxy: `server/src/llm/credentials.ts` `defaultCredentialKey`).
 */
export function getOpenAIRequestKey(arg: RequestDataArgumentExtended, defaultKey: string): string {
    if (arg.key != null) {
        return arg.key;
    }
    const keyIdentifier = arg.modelInfo?.keyIdentifier;
    if (keyIdentifier && credentialSlotOf(arg.aiModel ?? "", arg.modelInfo)?.slot === "keyIdentifier") {
        const keys = arg.ctx.db.OaiCompAPIKeys ?? {};
        return Object.hasOwn(keys, keyIdentifier) ? (keys[keyIdentifier] ?? "") : "";
    }
    return defaultCredentialKey(arg.aiModel, defaultKey);
}

/** Optional transport overrides for local routing and a streaming request's deadline. */
export interface LocalNetworkRequestOptions {
    networkRoute?: "auto" | "local_network";
    requestTimeoutMs?: number;
}

/**
 * When the resolved profile's `localNetworkMode` is on and `url` is a local-network address, the request takes the
 * `local_network` route; a streaming call also gets the profile's positive `localNetworkTimeoutSec` (default 600
 * seconds) as its timeout. The OpenAI Chat and Responses adapters call it for their request and replacement URLs.
 */
export function getLocalNetworkRequestOptions(
    url: string,
    db: RequestDb,
    useStreaming = false,
): LocalNetworkRequestOptions {
    if (!db.localNetworkMode || !isLocalNetworkUrl(url)) {
        return {};
    }

    const timeoutSec =
        Number.isFinite(db.localNetworkTimeoutSec) && db.localNetworkTimeoutSec > 0 ? db.localNetworkTimeoutSec : 600;

    return {
        networkRoute: "local_network",
        requestTimeoutMs: useStreaming ? Math.max(1, Math.floor(timeoutSec * 1000)) : undefined,
    };
}
