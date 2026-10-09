import { isLocalNetworkUrl } from "../../../../shared/localNetwork.ts";
import { credentialSlotOf } from "../../../../shared/llm/credentialSlots.ts";
import { defaultCredentialKey } from "../credentials.ts";
import type { RequestDataArgumentExtended } from "../request.ts";
import type { RequestDb } from "../settings.ts";

/** A provider-specific key never falls through to another provider's default, even on direct calls. */
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

export interface LocalNetworkRequestOptions {
    networkRoute?: "auto" | "local_network";
    requestTimeoutMs?: number;
}

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
