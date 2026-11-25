import { language } from "src/lang";

// The placeholder stays on one line and Chromium clips its end without an ellipsis, so a long
// persona name would otherwise hide the character's on a phone. The character's name comes last and
// keeps the width it can get.
const PERSONA_LIMIT = 8;

function shortenedPersona(name: string) {
    const characters = Array.from(name);
    return characters.length > PERSONA_LIMIT ? `${characters.slice(0, PERSONA_LIMIT).join("")}…` : name;
}

/**
 * The main composer's placeholder: who writes to whom, or that the chat needs its setup first. The composer
 * shows it with `white-space: pre` (`placeholder:whitespace-pre` in `DefaultChatScreen.svelte`): it never wraps,
 * so the composer's height does not grow with the names' length, and a persona without a name keeps the leading
 * space of ` → character`.
 */
export function composerPlaceholder(options: {
    setupNeeded: boolean;
    playground: boolean;
    persona: string | undefined;
    character: string;
}) {
    if (options.setupNeeded) {
        return language.chatBinding.setupNeeded;
    }
    if (options.playground) {
        return "";
    }
    return `${shortenedPersona(options.persona ?? "")} → ${options.character}`;
}
