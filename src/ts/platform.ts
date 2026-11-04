/**
 * The platform flags, and the labels of the error dialog's stack trace block (`src/lib/Others/AlertComp.svelte`). The
 * app runs only on the self-host server, so no module past `src/main.ts` branches on `isNodeServer`; the other flags
 * describe the device and the browser.
 */

type UserAgentDataLike = {
    platform?: string;
    getHighEntropyValues?: (hints: string[]) => Promise<{
        platformVersion?: string;
    }>;
};

type BrowserNavigator = Navigator & {
    userAgentData?: UserAgentDataLike;
    standalone?: boolean;
};

export type RisuEnvironmentLabel = "node" | "node(dev)";

const browserNavigator = navigator as BrowserNavigator;

/**
 * True only when the page was served with the injected `globalThis.__NODE__ = true`: by the self-host server for `/`,
 * `/index.html`, and the client routes (`serveCachedIndex` in `server/src/http/staticCache.ts`, from
 * `server/src/app.ts`), or by the `risu-node-flag` plugin of the Vite dev server (`vite.config.ts`). Read only by
 * `src/main.ts`.
 */
export const isNodeServer: boolean = !!(globalThis as typeof globalThis & { __NODE__?: boolean }).__NODE__;
/** A mobile user-agent heuristic; it misses iPads that report a desktop user agent. */
export const isMobile: boolean = /Android|iPhone|iPad|iPod|webOS/i.test(browserNavigator.userAgent);

function normalizeOSVersion(version?: string | null): string | null {
    if (!version) {
        return null;
    }

    const normalized = version.trim().replace(/_/g, ".");
    return normalized && normalized !== "0.0.0" ? normalized : null;
}

function formatOSName(osName: string): string {
    switch (osName.toLowerCase()) {
        case "macos":
            return "macOS";
        case "ios":
            return "iOS";
        case "windows":
            return "Windows";
        case "android":
            return "Android";
        case "linux":
            return "Linux";
        case "chromeos":
            return "ChromeOS";
        default:
            return osName;
    }
}

function joinOSLabel(osName: string, version: string | null): string {
    return version ? `${osName} ${version}` : osName;
}

/** An iOS device, including iPadOS 13+, which reports `MacIntel` with touch points instead of an iPad agent. */
export function isIOS(): boolean {
    const ua = browserNavigator.userAgent || "";
    const isAppleMobile = /iPad|iPhone|iPod/.test(ua);

    // iPadOS 13+
    const isIpadOS = browserNavigator.platform === "MacIntel" && browserNavigator.maxTouchPoints > 1;

    return isAppleMobile || isIpadOS;
}

function getBrowserOSName(): string {
    const uaPlatform = browserNavigator.userAgentData?.platform;
    if (uaPlatform) {
        return formatOSName(uaPlatform);
    }

    const ua = browserNavigator.userAgent || "";
    const platform = browserNavigator.platform || "";

    if (/Windows/i.test(ua)) return "Windows";
    if (/Android/i.test(ua)) return "Android";
    if (isIOS()) return "iOS";
    if (/CrOS/i.test(ua)) return "ChromeOS";
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return "macOS";
    if (/Linux/i.test(platform) || /Linux/i.test(ua)) return "Linux";

    return platform || "Unknown";
}

function getUserAgentOSVersion(osName: string): string | null {
    const ua = browserNavigator.userAgent || "";

    switch (osName) {
        case "Android":
            return normalizeOSVersion(ua.match(/Android ([\d.]+)/i)?.[1]);
        case "iOS":
            return normalizeOSVersion(ua.match(/(?:CPU (?:iPhone )?OS|iPhone OS|CPU OS) ([\d_]+)/i)?.[1]);
        case "ChromeOS":
            return normalizeOSVersion(ua.match(/CrOS [^ ]+ ([\d.]+)/i)?.[1]);
        case "Windows": {
            const windowsVersion = normalizeOSVersion(ua.match(/Windows NT ([\d.]+)/i)?.[1]);
            return windowsVersion ? `NT ${windowsVersion}` : null;
        }
        default:
            return null;
    }
}

async function getBrowserHighEntropyOSVersion(): Promise<string | null> {
    try {
        const values = await browserNavigator.userAgentData?.getHighEntropyValues?.(["platformVersion"]);
        return normalizeOSVersion(values?.platformVersion);
    } catch (error) {
        console.warn("Failed to read browser platformVersion:", error);
        return null;
    }
}

/** The "Risu environment" line of the error dialog: `node(dev)` in a Vite dev build, else `node`. */
export function getRisuEnvironmentLabel(): RisuEnvironmentLabel {
    if (import.meta.env.DEV) {
        return "node(dev)";
    }

    return "node";
}

/**
 * The OS label, synchronously: the name can come from the Client Hints (`userAgentData.platform`), the version only
 * from the user agent and only when the parser recognizes one. `src/lib/Others/AlertComp.svelte` shows it until
 * `getDetailedOSLabel` resolves.
 */
export function getFallbackOSLabel(): string {
    const osName = getBrowserOSName();
    return joinOSLabel(osName, getUserAgentOSVersion(osName));
}

/**
 * The OS label with the version from the User-Agent Client Hints (`platformVersion`) when the browser gives it, else
 * the user agent's (`src/lib/Others/AlertComp.svelte`). It never rejects.
 */
export async function getDetailedOSLabel(): Promise<string> {
    const osName = getBrowserOSName();
    const browserVersion = await getBrowserHighEntropyOSVersion();

    return joinOSLabel(osName, browserVersion ?? getUserAgentOSVersion(osName));
}

/** Unused: `loadData` in `src/ts/bootstrap.ts` recomputes standalone mode before `navigator.storage.persist`. */
export const isInStandaloneMode =
    window.matchMedia("(display-mode: standalone)").matches ||
    !!browserNavigator.standalone ||
    document.referrer.includes("android-app://");
