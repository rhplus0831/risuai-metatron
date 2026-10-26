export function isImeComposing(event: KeyboardEvent): boolean {
    // Safari can end composition before dispatching the candidate's commit key.
    return event.isComposing || event.keyCode === 229;
}
