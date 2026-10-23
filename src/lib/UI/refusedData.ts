import { SECTION_FIELDS, type SectionKind } from "../../../shared/sections.ts";
import { llmSecretsText } from "src/ts/storage/llmSecrets.svelte";
import type { RefusedItem } from "src/ts/storage/resourceSync.svelte";

export type RefusedRecordItem = Extract<RefusedItem, { kind: "record" }>;

/** Chat banners own registered chat keys; every other refusal belongs in the app banner. */
export function refusedItemsFor(
    items: readonly RefusedItem[],
    displayedChatKeys: ReadonlySet<string>,
    form: "chat" | "app",
): RefusedItem[] {
    return items.filter((item) => {
        const displayed = item.kind === "chat" && displayedChatKeys.has(`${item.chaId}\u0000${item.chatId}`);
        return form === "chat" ? displayed : !displayed;
    });
}

const CHARACTER_LOCAL_KEYS = new Set(["chats", "chatPage", "reloadKeys"]);

/** The save projection in a JSON envelope. Values stay live until serialized, preserving own user keys. */
export function refusedRecordExportText(item: RefusedRecordItem, record: unknown): string | undefined {
    if (record === undefined) return undefined;
    let data = record;
    let text: string | undefined;
    if (item.resourceKind === "llmSecrets") {
        text = llmSecretsText(record as Record<string, unknown>);
    } else {
        if (Object.hasOwn(SECTION_FIELDS, item.resourceKind)) {
            const fields = SECTION_FIELDS[item.resourceKind as SectionKind];
            data = Object.fromEntries(fields.map((field) => [field, (record as Record<string, unknown>)[field]]));
        } else if (item.resourceKind === "characters") {
            data = Object.fromEntries(
                Object.keys(record as object)
                    .filter((key) => !CHARACTER_LOCAL_KEYS.has(key))
                    .map((key) => [key, (record as Record<string, unknown>)[key]]),
            );
        }
        text = JSON.stringify(data);
    }
    return `{"kind":${JSON.stringify(item.resourceKind)},"id":${JSON.stringify(item.id)},"data":${text}}`;
}
