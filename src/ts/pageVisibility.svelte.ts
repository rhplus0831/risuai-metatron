let visible = $state(typeof document !== "undefined" && document.visibilityState === "visible");
let recoveryVersion = $state(0);

if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        const next = document.visibilityState === "visible";
        if (next && !visible) recoveryVersion += 1;
        visible = next;
    });
}

if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
        recoveryVersion += 1;
    });
}

/** Whether this page's content is visible (reactive). */
export function isPageVisible(): boolean {
    return visible;
}

/** Changes when the page becomes visible or the browser comes back online (reactive). */
export function pageRecoveryVersion(): number {
    return recoveryVersion;
}
