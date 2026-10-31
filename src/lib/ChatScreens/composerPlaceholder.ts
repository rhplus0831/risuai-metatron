import { language } from "src/lang";

// The placeholder stays on one line and Chromium clips its end without an ellipsis, so a long
// persona name would otherwise hide the character's on a phone. The character's name comes last and
// keeps the width it can get.
const PERSONA_LIMIT = 8;

function shortenedPersona(name: string) {
    const characters = Array.from(name);
    return characters.length > PERSONA_LIMIT ? `${characters.slice(0, PERSONA_LIMIT).join("")}…` : name;
}

/** The main composer's placeholder: who writes to whom, or that the chat needs its setup first. */
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
