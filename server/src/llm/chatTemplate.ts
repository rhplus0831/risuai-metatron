import type { OpenAIChat } from "../../../shared/openai.ts";
import { renderChatTemplate } from "../../../shared/prompt/chatTemplate.ts";
import type { RequestContext } from "./context.ts";

/**
 * The client's `applyChatTemplate` (`src/ts/process/templates/chatTemplate.ts`) with the request's
 * preset, its selected character, and its user name. Both names are read on every render,
 * so any template throws when no character is selected.
 */
export function applyChatTemplate(
    messages: OpenAIChat[],
    ctx: Pick<RequestContext, "db" | "selectedCharacterName" | "userName">,
    arg: { type?: string; custom?: string } = {},
) {
    const db = ctx.db;
    const type = arg.type ?? db.instructChatTemplate;
    if (!type) {
        throw new Error("Template type is not set");
    }
    return renderChatTemplate(messages, {
        type,
        jinjaTemplate: arg.custom ?? db.JinjaTemplate,
        characterName: () => {
            if (ctx.selectedCharacterName === null) {
                throw new TypeError("Cannot read properties of undefined (reading 'name')");
            }
            return ctx.selectedCharacterName;
        },
        userName: () => ctx.userName,
    });
}
