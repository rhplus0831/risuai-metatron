/**
 * An unattended Remote Host on this machine's server. The tab owns all app work: this process
 * only sets the two host preferences before boot, reads DOM markers and the app's auth answer,
 * and supplies Escape, the terminal notice's OK, or the password once. It never clears safe boot.
 * Run state (passwordUsed and restartWait) survives pages and browser relaunches; load state does not.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
    BOOT_DEADLINE_MS,
    DISMISS_TRIES,
    EXIT_CODES,
    LOG_TEXT_LIMIT,
    RESTART_MIN_MS,
    TICK_MS,
    consoleLocationText,
    consoleTypeLogged,
    cutDialogText,
    hostRootUrl,
    nextRestartWait,
    oneLine,
    pluginsOffReloadAt,
    readHeadlessHostConfig,
    redactCredentials,
    resetRestartWait,
} from "./headlessHostConfig.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
let settings;
let chromePath;
let chromium;
let context;
let launchingContext;
let browserGone = false;
let currentPage;
let load;
let restart;
let restartWait = RESTART_MIN_MS;
let passwordUsed = false;
let stopping = false;
let shutdownPromise;
let rootUrl;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeText = (text) => redactCredentials(text, settings?.password, rootUrl && new URL(rootUrl).origin);
const dialogText = (text) => cutDialogText(safeText(text));

function log(message) {
    const line = oneLine(safeText(message));
    console.log(`${new Date().toISOString()} ${line.slice(0, LOG_TEXT_LIMIT)}`);
}

/** Every controlled exit, including a signal during launch, closes the persistent context first. */
function shutdown(code, message) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    log(message);
    shutdownPromise = (async () => {
        // A signal can arrive before launchPersistentContext hands us its context.
        const pending = await launchingContext?.catch(() => null);
        const closing = context ?? pending;
        if (closing) {
            try {
                await closing.close();
            } catch {
                log("Context close failed; closing its browser");
                try {
                    await closing.browser()?.close();
                } catch {
                    log("Browser close failed");
                }
            }
        }
        // Flush the last stdout event before exiting, including when stdout is a pipe.
        process.stdout.write("", () => process.exit(code));
    })();
    return shutdownPromise;
}

// Windows reports a closed console window as SIGHUP (the process is killed about 10 s later) and
// Ctrl+Break as SIGBREAK. Elsewhere SIGHUP stays with Playwright, which closes the browser for a
// restart, so a run under nohup outlives its terminal.
for (const signal of ["SIGINT", "SIGTERM", ...(windows ? ["SIGHUP", "SIGBREAK"] : [])]) {
    process.on(signal, () => void shutdown(EXIT_CODES.OK, `Stopped by ${signal}`));
}

/** Wait for the server without starting it; a refused connection is normal during startup. */
async function waitForListener(host, port) {
    log(`Waiting for listener on ${hostRootUrl("http", host, port)}`);
    while (!stopping) {
        const open = await new Promise((resolve) => {
            const socket = net.connect({ host, port });
            const finish = (ok) => {
                socket.destroy();
                resolve(ok);
            };
            socket.setTimeout(TICK_MS, () => finish(false));
            socket.once("connect", () => finish(true));
            socket.once("error", () => finish(false));
        });
        if (open) return;
        await sleep(TICK_MS);
    }
}

async function listenerScheme(host, port) {
    return new Promise((resolve) => {
        const socket = tls.connect({ host, port, rejectUnauthorized: false });
        // A wall-clock bound, not an idle timeout: even a peer sending bytes cannot extend it.
        const timer = setTimeout(() => finish("http"), 3_000);
        function finish(scheme) {
            clearTimeout(timer);
            socket.destroy();
            resolve(scheme);
        }
        socket.once("secureConnect", () => finish("https"));
        socket.once("error", () => finish("http"));
        socket.once("end", () => finish("http"));
    });
}

function newLoad() {
    return {
        startedAt: Date.now(),
        readyAt: null,
        authStatus: "unknown",
        authSequence: 0,
        authPending: new Set(),
        dialog: null,
        feed: null,
        commands: new Map(),
        reloadNotice: false,
        pluginsOff: false,
    };
}

const isCurrent = (page, document) => !stopping && page === currentPage && document === load;

function resetWait(now) {
    restartWait = resetRestartWait(restartWait, load?.readyAt === null ? 0 : now - (load?.readyAt ?? now));
}

function scheduleRestart(reason, pluginsOff = false) {
    if (stopping || (restart && (!restart.pluginsOff || pluginsOff))) return;
    const now = Date.now();
    resetWait(now);
    const at = pluginsOff ? pluginsOffReloadAt(load.readyAt, now, restartWait) : now + restartWait;
    restart = { at, reason, pluginsOff };
    log(`Restart in ${Math.ceil((at - now) / 1000)} s: ${reason}`);
}

async function launchBrowser() {
    if (stopping) return;
    browserGone = false;
    try {
        launchingContext = chromium.launchPersistentContext(settings.profileDir, {
            executablePath: chromePath,
            headless: true,
            // shutdown owns signals; Playwright's default SIGINT handler exits with 130.
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: !windows,
            // Ignoring certificate errors is safe here only because the configured address is loopback.
            ignoreHTTPSErrors: true,
        });
        context = await launchingContext;
    } catch (error) {
        const locked = /ProcessSingleton|SingletonLock|profile.*(?:in use|locked)|user data directory.*in use/i.test(
            String(error),
        );
        await shutdown(
            EXIT_CODES.STARTUP,
            locked
                ? `Chrome profile is held by another Chrome: ${settings.profileDir}`
                : `Could not launch Chrome (${chromePath}); check the binary and profile folder ${settings.profileDir}, which another Chrome may hold`,
        );
        return;
    } finally {
        launchingContext = null;
    }
    if (stopping) return;
    const launched = context;
    const closed = (reason) => {
        if (context !== launched || stopping) return;
        browserGone = true;
        scheduleRestart(reason);
    };
    launched.on("close", () => closed("browser context closed"));
    launched.browser()?.on("disconnected", () => closed("browser disconnected"));
    launched.setDefaultTimeout(TICK_MS);
    await launched.addInitScript((values) => {
        // about:blank and opaque origins have no usable localStorage.
        try {
            if (location.origin === "null") return;
            for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
        } catch {}
    }, settings.localStorageValues);
}

/** Read only the app's current-document auth checks; response headers arrive before the JSON body. */
function watchAuth(page) {
    const requests = new WeakMap();
    page.on("request", (request) => {
        if (page !== currentPage || stopping) return;
        const url = new URL(request.url());
        if (url.origin !== new URL(rootUrl).origin || url.pathname !== "/api/test_auth") return;
        if (request.frame() !== page.mainFrame()) return;
        const document = load;
        const sequence = ++document.authSequence;
        document.authPending.add(request);
        document.authStatus = "pending";
        requests.set(request, { document, sequence });
    });
    page.on("requestfailed", (request) => {
        const tracked = requests.get(request);
        if (!tracked || !isCurrent(page, tracked.document)) return;
        tracked.document.authPending.delete(request);
        if (tracked.sequence === tracked.document.authSequence) tracked.document.authStatus = "unreadable";
    });
    page.on("response", async (response) => {
        const request = response.request();
        const tracked = requests.get(request);
        if (!tracked || !isCurrent(page, tracked.document)) return;
        const { document, sequence } = tracked;
        let status = "unreadable";
        try {
            const body = await response.json();
            if (["unset", "incorrect", "success"].includes(body?.status)) status = body.status;
        } catch {
            // A secret dialog with an unknown classification is left alone until the boot deadline.
        }
        if (!isCurrent(page, document)) return;
        document.authPending.delete(request);
        if (status === "unset") {
            await shutdown(EXIT_CODES.PASSWORD_UNSET, "Server password is unset; set it from a person's browser first");
            return;
        }
        if (sequence === document.authSequence) document.authStatus = response.ok() ? status : "unreadable";
    });
}

async function openPage() {
    if (stopping) return;
    if (!context || browserGone) {
        // A closed context cannot be repaired with newPage or goto.
        const old = context;
        context = null;
        if (old) await old.close().catch(() => {});
        await launchBrowser();
    }
    if (stopping) return;
    currentPage = null; // Closing the previous page is intentional, not another failure.
    for (const page of context.pages()) await page.close().catch(() => {});
    if (stopping) return;
    const page = await context.newPage();
    if (stopping) return;
    currentPage = page;
    load = newLoad();
    page.on("crash", () => {
        if (page === currentPage) scheduleRestart("page crashed");
    });
    page.on("close", () => {
        if (page === currentPage) scheduleRestart("page closed");
    });
    page.on("console", (message) => {
        const type = message.type();
        if (!consoleTypeLogged(settings.consoleLevel, type)) return;
        log(`Page console ${type}: ${message.text()}${consoleLocationText(message.location())}`);
    });
    // The stack starts with the message in Chrome; its frames say which script threw.
    page.on("pageerror", (error) => log(`Page error: ${error.stack || error.message}`));
    page.on("dialog", async (dialog) => {
        log(`Dismiss native ${dialog.type()}: ${dialogText(dialog.message())}`);
        try {
            await dialog.dismiss();
        } catch {
            if (page === currentPage) scheduleRestart("native dialog could not be dismissed");
        }
    });
    // Chrome's document navigation event excludes same-document SPA history changes. Playwright's
    // framenavigated also reports those; resetting auth on one would lose a successful classification.
    const session = await context.newCDPSession(page);
    session.on("Page.frameNavigated", ({ frame }) => {
        if (!frame.parentId && page === currentPage) {
            load = newLoad();
            // An app-initiated reload already replaces a plugins-off page.
            if (restart?.pluginsOff) restart = null;
        }
    });
    await session.send("Page.enable");
    watchAuth(page);
    const initialLoad = load;
    // Wait only for the document commit, not load: auth prompts can hold the rest of boot open.
    await page.goto(rootUrl, { waitUntil: "commit", timeout: BOOT_DEADLINE_MS }).catch((error) => {
        if (isCurrent(page, initialLoad)) scheduleRestart(`navigation failed: ${error.message}`);
    });
}

async function forgetDialog(document) {
    const previous = document.dialog;
    document.dialog = null;
    await previous?.element.dispose().catch(() => {});
}

async function handleDialog(page, document, ready) {
    const element = await page.$("[data-alert-dialog]:visible");
    if (!element) {
        await forgetDialog(document);
        return;
    }
    const info = await element.evaluate((panel) => ({
        text: panel.innerText,
        secret: !!panel.querySelector("#alert-input[data-plugin-secret]"),
        // wait2 is queued but has no controls; AlertComp marks it with the vis class.
        queued:
            panel.classList.contains("vis") || !!panel.querySelector("button, input, textarea, select, [role=button]"),
    }));
    if (!isCurrent(page, document)) {
        await element.dispose();
        return;
    }
    if (info.secret) {
        if (document.authPending.size || ["unknown", "pending", "unreadable"].includes(document.authStatus)) {
            await element.dispose();
            return;
        }
        if (document.authStatus === "incorrect") {
            document.authStatus = "used";
            if (passwordUsed) {
                await shutdown(
                    EXIT_CODES.PASSWORD_REFUSED,
                    "Server asked for the password again; a refused password is never retried",
                );
            } else if (!settings.password) {
                await shutdown(
                    EXIT_CODES.PASSWORD_MISSING,
                    "Server password required; set RISU_HEADLESS_HOST_PASSWORD for the first start",
                );
            } else {
                passwordUsed = true;
                try {
                    const input = await element.$("#alert-input[data-plugin-secret]");
                    if (!isCurrent(page, document) || document.authPending.size) throw new Error("prompt changed");
                    await input.fill(settings.password);
                    if (!isCurrent(page, document) || document.authPending.size) throw new Error("prompt changed");
                    await input.press("Enter");
                    log("Server password submitted");
                } catch {
                    // Playwright fill's call log contains the password: never log this error.
                    await shutdown(EXIT_CODES.STARTUP, "Could not enter the server password; stopping without retry");
                }
            }
            await element.dispose().catch(() => {});
            return;
        }
    }
    const previous = document.dialog;
    const same =
        previous &&
        previous.text === info.text &&
        (await previous.element.evaluate((old, shown) => old === shown, element).catch(() => false));
    if (!same) {
        await forgetDialog(document);
        document.dialog = { element, text: info.text, strokes: 0 };
    } else {
        await element.dispose();
    }
    if (!isCurrent(page, document)) return;
    const shown = document.dialog;
    // wait/progress use this wrapper too, with no controls. Before the lock screen supplies
    // data-dialogs, they must not turn a healthy long boot into a ten-stroke failed load.
    const countStroke = ready || info.queued;
    if (countStroke && shown.strokes >= DISMISS_TRIES) {
        log(`Dialog not dismissable: ${dialogText(info.text)}`);
        scheduleRestart("dialog not dismissable");
        return;
    }
    const mayDismissSecret = () => !document.authPending.size && ["success", "used"].includes(document.authStatus);
    if (info.secret && !mayDismissSecret()) return;
    const attached = await shown.element.evaluate(
        (panel, observed) => {
            // A status and a dialog can reuse the wrapper. Do not act on its replacement.
            if (
                !panel.isConnected ||
                panel.innerText !== observed.text ||
                !!panel.querySelector("#alert-input[data-plugin-secret]") !== observed.secret
            )
                return false;
            document.activeElement?.blur();
            return true;
        },
        { text: info.text, secret: info.secret },
    );
    if (!attached || !isCurrent(page, document)) return;
    // Classification may have changed while reading/blurring the DOM.
    if (info.secret && !mayDismissSecret()) return;
    log(`Dismiss dialog with Escape: ${dialogText(info.text)}`);
    await page.keyboard.press("Escape");
    if (countStroke) shown.strokes++;
}

async function tick() {
    const page = currentPage;
    const document = load;
    if (!page || page.isClosed() || browserGone) return;
    const screen = await page.$("[data-remote-host-screen]");
    if (!isCurrent(page, document) || (restart && !restart.pluginsOff)) {
        await screen?.dispose();
        return;
    }
    const ready = !!screen;
    if (!ready) document.readyAt = null;
    else if (document.readyAt === null) {
        document.readyAt = Date.now();
        log("Remote Host ready");
    }
    resetWait(Date.now());
    const terminal = await page.$("[data-terminal-notice]");
    if (terminal) {
        log(`Acknowledge terminal notice: ${dialogText(await terminal.innerText())}`);
        const button = await terminal.$("button");
        await button.click();
        await button.dispose();
        await terminal.dispose();
        await screen?.dispose();
        return; // The app owns the resulting reload.
    }
    const dialogs = ready ? (await screen.getAttribute("data-dialogs")) === "true" : true;
    if (dialogs) await handleDialog(page, document, ready);
    else await forgetDialog(document);
    if (!isCurrent(page, document) || (restart && !restart.pluginsOff)) {
        await screen?.dispose();
        return;
    }
    if (!ready) {
        if (Date.now() - document.startedAt >= BOOT_DEADLINE_MS) scheduleRestart("no ready state within 120 s");
        return;
    }
    const state = await screen.evaluate((root) => ({
        feed: root.getAttribute("data-feed-connected"),
        pluginsOff: root.getAttribute("data-plugins-off") === "true",
        commands: Array.from(root.querySelectorAll("li[data-command-id]"), (row) => ({
            id: row.getAttribute("data-command-id"),
            type: row.getAttribute("data-command-type"),
            state: row.getAttribute("data-command-state"),
            code: row.getAttribute("data-command-code"),
        })),
    }));
    await screen.dispose();
    if (!isCurrent(page, document)) return;
    if (state.feed !== document.feed) {
        document.feed = state.feed;
        log(`Feed ${state.feed === "true" ? "up" : "down"}`);
    }
    const commands = new Map();
    for (const command of state.commands) {
        commands.set(command.id, command.state);
        if (document.commands.get(command.id) !== command.state) {
            log(`Command ${command.id} ${command.type}: ${command.state}${command.code ? ` (${command.code})` : ""}`);
        }
    }
    document.commands = commands;
    const notice = await page.$("[data-reload-notice]");
    if (notice && !document.reloadNotice) log(`Reload notice: ${dialogText(await notice.innerText())}`);
    document.reloadNotice = !!notice;
    await notice?.dispose();
    if (state.pluginsOff && !document.pluginsOff) {
        document.pluginsOff = true;
        log("Plugins are off for this page load");
        scheduleRestart("plugins off", true);
    }
}

async function main() {
    try {
        settings = readHeadlessHostConfig({ ...process.env }, rootDir, process.platform);
    } catch (error) {
        await shutdown(EXIT_CODES.CONFIG, error.message);
        return;
    }
    try {
        ({ chromium } = await import("playwright-core"));
    } catch {
        await shutdown(
            EXIT_CODES.STARTUP,
            "playwright-core is unavailable; install development dependencies with pnpm install",
        );
        return;
    }
    chromePath = settings.chromePaths.find((file) => existsSync(file));
    if (!chromePath) {
        await shutdown(
            EXIT_CODES.STARTUP,
            `Chrome not found at ${settings.chromePaths.join(", ") || "any default path"}; install Google Chrome or set RISU_CHROME`,
        );
        return;
    }
    // Windows ignores the mode; the folder inherits the repository folder's permissions.
    await mkdir(settings.profileDir, { recursive: true, mode: 0o700 });
    await waitForListener(settings.host, settings.port);
    if (stopping) return;
    const scheme = await listenerScheme(settings.host, settings.port);
    if (stopping) return;
    rootUrl = hostRootUrl(scheme, settings.host, settings.port);
    log(`Starting ${JSON.stringify(settings.name)} at ${rootUrl}`);
    try {
        await openPage();
    } catch (error) {
        scheduleRestart(`page load failed: ${error.message}`);
    }
    while (!stopping) {
        let attemptedLoad = load;
        try {
            if (restart && Date.now() >= restart.at) {
                const reason = restart.reason;
                // Only a live plugins-off page can accrue ready time during the wait.
                if (restart.pluginsOff) resetWait(Date.now());
                if (load) load.readyAt = null;
                restartWait = nextRestartWait(restartWait);
                restart = null;
                log(`Restarting: ${reason}`);
                await openPage();
            }
            attemptedLoad = load;
            if (!restart || restart.pluginsOff) await tick();
        } catch (error) {
            // A read interrupted by the app's own reload belongs to the old document.
            // Chrome can report the destroyed execution context before its navigation event arrives.
            const navigating = /Execution context was destroyed|Cannot find context with specified id/.test(
                error.message,
            );
            if (!stopping && !navigating && (attemptedLoad === load || browserGone)) {
                scheduleRestart(`page load failed: ${error.message}`);
            }
        }
        await sleep(TICK_MS);
    }
}

void main().catch((error) => shutdown(EXIT_CODES.STARTUP, `Headless host failed: ${error.message}`));
