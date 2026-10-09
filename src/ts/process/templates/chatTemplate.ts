import { selectedCharacter } from "../../storage/characterStore.svelte";
import { activeMainProfile } from "../../storage/settingsViews.svelte";
import type { ModelProfile } from "../../../../shared/database.ts";
import { presetFieldValue } from "../../../../shared/presets.ts";
import type { OpenAIChat } from "../index.svelte";
import { getUserName } from "src/ts/util";
import { chatTemplates, renderChatTemplate, templateEffect } from "../../../../shared/prompt/chatTemplate.ts";

// The templates moved to `shared/prompt/chatTemplate.ts` (Phase 5); this wrapper supplies the
// selected profile's settings, the selected character, and the user's name.
export { chatTemplates, templateEffect };

export const applyChatTemplate = (
    messages: OpenAIChat[],
    arg: {
        type?: string;
        custom?: string;
        /** A captured request profile; null uses defaults instead of the active profile. */
        profile?: ModelProfile | null;
    } = {},
) => {
    const currentChar = selectedCharacter();
    const field = (name: "instructChatTemplate" | "JinjaTemplate") =>
        arg.profile === undefined
            ? activeMainProfile[name]
            : (presetFieldValue(arg.profile ?? undefined, name) as string);
    const type = arg.type ?? field("instructChatTemplate");
    if (!type) {
        throw new Error("Template type is not set");
    }
    return renderChatTemplate(messages, {
        type,
        jinjaTemplate: arg.custom ?? field("JinjaTemplate"),
        characterName: () => currentChar.name,
        userName: () => getUserName(),
    });
};
