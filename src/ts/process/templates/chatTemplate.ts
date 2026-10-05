import { selectedCharacter } from "../../storage/characterStore.svelte";
import { activePreset } from "../../storage/settingsViews.svelte";
import type { OpenAIChat } from "../index.svelte";
import { getUserName } from "src/ts/util";
import { chatTemplates, renderChatTemplate, templateEffect } from "../../../../shared/prompt/chatTemplate.ts";

// The templates moved to `shared/prompt/chatTemplate.ts` (Phase 5); this wrapper supplies the
// selected preset's settings, the selected character, and the user's name.
export { chatTemplates, templateEffect };

export const applyChatTemplate = (
    messages: OpenAIChat[],
    arg: {
        type?: string;
        custom?: string;
    } = {},
) => {
    const currentChar = selectedCharacter();
    const type = arg.type ?? activePreset.instructChatTemplate;
    if (!type) {
        throw new Error("Template type is not set");
    }
    return renderChatTemplate(messages, {
        type,
        jinjaTemplate: arg.custom ?? activePreset.JinjaTemplate,
        characterName: () => currentChar.name,
        userName: () => getUserName(),
    });
};
