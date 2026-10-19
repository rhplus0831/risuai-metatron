/**
 * A chat's greeting (`Chat.fmIndex`): -1 is the character's `firstMessage`, `0..n-1` one of its
 * `alternateGreetings`. A stored index can be missing (an old chat row) or out of range (a greeting
 * deleted after the chat chose it), so readers go through `greetingIndex`: anything that is not an
 * integer in `-1..n-1` reads as -1, the main first message.
 */
export function greetingIndex(fmIndex: unknown, alternateGreetingCount: number): number {
    if (
        typeof fmIndex !== "number" ||
        !Number.isInteger(fmIndex) ||
        fmIndex < -1 ||
        fmIndex >= alternateGreetingCount
    ) {
        return -1;
    }
    return fmIndex;
}

/** The greeting text a chat shows for `fmIndex`, by `greetingIndex`. */
export function greetingText(
    character: { firstMessage: string; alternateGreetings?: readonly string[] | null },
    fmIndex: unknown,
): string {
    const greetings = character.alternateGreetings ?? [];
    const index = greetingIndex(fmIndex, greetings.length);
    return index === -1 ? character.firstMessage : greetings[index];
}

/** The greeting after `fmIndex` (the greeting reroll), wrapping from the last alternate to -1. */
export function nextGreetingIndex(fmIndex: unknown, alternateGreetingCount: number): number {
    const index = greetingIndex(fmIndex, alternateGreetingCount);
    return index >= alternateGreetingCount - 1 ? -1 : index + 1;
}

/** The greeting before `fmIndex` (the greeting unreroll), wrapping from -1 to the last alternate. */
export function previousGreetingIndex(fmIndex: unknown, alternateGreetingCount: number): number {
    const index = greetingIndex(fmIndex, alternateGreetingCount);
    return index === -1 ? alternateGreetingCount - 1 : index - 1;
}
