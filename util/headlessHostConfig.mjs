/** Pure settings and timing rules for the headless host. No environment or clock is read here. */
import path from "node:path";
import { isLoopbackHost } from "../server/src/listenConfig.ts";
import { MAX_FEED_CLIENT_NAME } from "../shared/events.ts";

export const TICK_MS = 1_000;
export const BOOT_DEADLINE_MS = 120_000;
export const DISMISS_TRIES = 10;
export const RESTART_MIN_MS = 5_000;
export const RESTART_MAX_MS = 300_000;
export const READY_RESET_MS = 60_000;
// Mirrors src/ts/safeBoot.ts; importing that browser module would run app logic.
export const SAFE_BOOT_SETTLE_MS = 10_000;
export const SAFE_BOOT_MARGIN_MS = 1_000;
export const DIALOG_TEXT_LIMIT = 512;
export const LOG_TEXT_LIMIT = 2_000;
export const EXIT_CODES = Object.freeze({
    OK: 0,
    STARTUP: 1,
    CONFIG: 2,
    PASSWORD_UNSET: 3,
    PASSWORD_MISSING: 4,
    PASSWORD_REFUSED: 5,
});

export function resolveHeadlessHostAddress(raw) {
    const host = raw?.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
    if (isLoopbackHost(host)) return host;
    throw new Error("RISU_HOST must be a numeric loopback address without brackets, or a wildcard (0.0.0.0 or ::)");
}

/** Blank ports are unset: use RISU_HEADLESS_HOST_PORT, then PORT, then 6001. */
export function resolveHeadlessHostPort(env) {
    const variable = env.RISU_HEADLESS_HOST_PORT?.trim() ? "RISU_HEADLESS_HOST_PORT" : "PORT";
    const raw = env[variable]?.trim();
    if (!raw) return 6001;
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${variable} must be an integer port from 1 to 65535`);
    }
    return port;
}

export function validateHeadlessHostName(name) {
    if (!name.trim() || name.length > MAX_FEED_CLIENT_NAME) {
        throw new Error(`RISU_HEADLESS_HOST_NAME must be nonblank and at most ${MAX_FEED_CLIENT_NAME} code units`);
    }
    return name;
}

/** Blank is unset. `error` keeps the default of console errors only; `warn` adds warnings; `all` forwards every type. */
export function resolveHeadlessHostConsole(raw) {
    const level = raw?.trim().toLowerCase() || "error";
    if (!["error", "warn", "all"].includes(level)) {
        throw new Error("RISU_HEADLESS_HOST_CONSOLE must be error, warn or all");
    }
    return level;
}

/** `type` is Playwright's ConsoleMessage.type(), where console.warn is "warning". */
export function consoleTypeLogged(level, type) {
    return level === "all" || type === "error" || (level === "warn" && type === "warning");
}

/** Values consumed by handoff.ts's preference(), before any app module starts. */
export function hostLocalStorageValues(name) {
    return { "risu-remote-host": JSON.stringify(true), "risu-handoff-name": JSON.stringify(name) };
}

/**
 * Google Chrome's usual install paths, tried in order. Windows and macOS follow Playwright's "chrome"
 * channel; Linux keeps the launcher on PATH. A copied Windows environment keeps its keys' original case
 * (`ProgramFiles`), so those names are matched without case.
 */
export function chromeCandidates(platform, env) {
    if (platform === "win32") {
        const value = (name) =>
            Object.entries(env)
                .find(([key]) => key.toUpperCase() === name)?.[1]
                ?.trim();
        return ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"]
            .map(value)
            .filter(Boolean)
            .map((dir) => path.win32.join(dir, "Google", "Chrome", "Application", "chrome.exe"));
    }
    if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
    return ["/usr/bin/google-chrome"];
}

/**
 * The caller supplies one environment snapshot, the repository root (never the working directory) and
 * the platform name (`process.platform`). A nonblank RISU_CHROME is the only Chrome path.
 */
export function readHeadlessHostConfig(env, rootDir, platform) {
    const name = validateHeadlessHostName(env.RISU_HEADLESS_HOST_NAME ?? "Headless host");
    return {
        host: resolveHeadlessHostAddress(env.RISU_HOST),
        port: resolveHeadlessHostPort(env),
        name,
        profileDir: path.resolve(rootDir, env.RISU_HEADLESS_HOST_PROFILE || "host-profile"),
        password: env.RISU_HEADLESS_HOST_PASSWORD,
        consoleLevel: resolveHeadlessHostConsole(env.RISU_HEADLESS_HOST_CONSOLE),
        chromePaths: env.RISU_CHROME?.trim() ? [env.RISU_CHROME] : chromeCandidates(platform, env),
        localStorageValues: hostLocalStorageValues(name),
    };
}

export function hostRootUrl(scheme, host, port) {
    return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}/`;
}

/** Call after spending a wait; resetRestartWait is also applied before scheduling it. */
export function nextRestartWait(waitMs) {
    return Math.min(waitMs * 2, RESTART_MAX_MS);
}

export function resetRestartWait(waitMs, readyForMs) {
    return readyForMs >= READY_RESET_MS ? RESTART_MIN_MS : waitMs;
}

export function pluginsOffReloadAt(readyAt, now, waitMs) {
    return Math.max(now + waitMs, readyAt + SAFE_BOOT_SETTLE_MS + SAFE_BOOT_MARGIN_MS);
}

export function oneLine(text) {
    return String(text)
        .replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, " ")
        .trim();
}

export function cutDialogText(text) {
    const line = oneLine(text);
    return line.length > DIALOG_TEXT_LIMIT ? `${line.slice(0, DIALOG_TEXT_LIMIT - 1)}…` : line;
}

/**
 * Where a console message came from, as text for the log. For Chrome's "Failed to load resource"
 * the URL is the resource itself, at position 0:0; otherwise it is the script. Playwright counts
 * lines and columns from 0; the log counts from 1, like a stack frame.
 */
export function consoleLocationText(location) {
    if (!location?.url) return "";
    const { lineNumber: line, columnNumber: column } = location;
    const position = line || column ? `:${line + 1}:${column + 1}` : "";
    // No closing bracket: the redactor's URL match would take it with a hidden query.
    return ` at ${location.url}${position}`;
}

/**
 * Redact before truncating or flattening lines. Keep only URL origins: credentials can live in
 * paths as well as query strings, fragments and userinfo. The served app's own origin (`appOrigin`)
 * also keeps its path, which names a route, asset or script and never a credential; its query and
 * fragment still go. Never forward request headers.
 * The known password's escaped/URL-encoded forms are covered too; fill errors are never forwarded.
 */
export function redactCredentials(text, password, appOrigin) {
    let result = String(text);
    if (password) {
        const forms = [password, JSON.stringify(password).slice(1, -1), encodeURIComponent(password)];
        for (const form of forms.sort((a, b) => b.length - a.length)) {
            result = result.split(form).join("[redacted]");
        }
    }
    result = result.replace(/(?:https?|wss?):\/\/[^\s<>"'`]+/gi, (raw) => {
        try {
            const url = new URL(raw);
            if (appOrigin && url.origin === appOrigin && !url.username && !url.password) {
                return `${url.origin}${url.pathname}${url.search || url.hash ? "[redacted]" : ""}`;
            }
            const hidden = url.username || url.password || url.search || url.hash || url.pathname !== "/";
            return `${url.protocol}//${url.host}/${hidden ? "[redacted]" : ""}`;
        } catch {
            return "[redacted URL]";
        }
    });
    return result
        .replace(/[?#][^\s<>"'`]+/g, "[redacted]")
        .replace(/\brisu-auth\b[\s\S]*/gi, "[redacted credential]")
        .replace(
            /\b(?:risu-auth|authorization|password|access[_-]?token|token|api[_-]?key)["']?\s*[:=][\s\S]*/gi,
            "[redacted credential]",
        )
        .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, "[redacted token]");
}
