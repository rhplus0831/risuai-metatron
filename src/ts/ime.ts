export function isImeComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
    // Safari can end composition before dispatching the candidate's commit key.
    return event.isComposing === true || event.keyCode === 229;
}
