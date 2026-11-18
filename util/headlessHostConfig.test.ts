// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    consoleLocationText,
    consoleTypeLogged,
    nextRestartWait,
    pluginsOffReloadAt,
    readHeadlessHostConfig,
    redactCredentials,
    RESTART_MIN_MS,
    resetRestartWait,
} from "./headlessHostConfig.mjs";

describe("headless host configuration", () => {
    it("uses IPv4 loopback for unset, blank, and wildcard RISU_HOST", () => {
        for (const host of [undefined, "", "  ", "0.0.0.0", "::"]) {
            expect(readHeadlessHostConfig({ RISU_HOST: host }, "/repo").host).toBe("127.0.0.1");
        }
    });

    it("preserves numeric IPv4 and IPv6 loopback literals", () => {
        for (const host of ["127.0.0.1", "127.42.7.9", "::1"]) {
            expect(readHeadlessHostConfig({ RISU_HOST: host }, "/repo").host).toBe(host);
        }
    });

    it("rejects names, bracketed IPv6, LAN, and Tailscale addresses with RISU_HOST", () => {
        for (const host of ["localhost", "[::1]", "192.168.1.10", "100.64.0.1"]) {
            expect(() => readHeadlessHostConfig({ RISU_HOST: host }, "/repo")).toThrow("RISU_HOST");
        }
    });

    it("uses the host port before PORT and defaults to 6001, treating blanks as unset", () => {
        expect(readHeadlessHostConfig({}, "/repo").port).toBe(6001);
        expect(readHeadlessHostConfig({ PORT: "7001" }, "/repo").port).toBe(7001);
        expect(readHeadlessHostConfig({ RISU_HEADLESS_HOST_PORT: "8001", PORT: "7001" }, "/repo").port).toBe(8001);
        for (const blank of ["", "  "]) {
            expect(readHeadlessHostConfig({ RISU_HEADLESS_HOST_PORT: blank, PORT: "7001" }, "/repo").port).toBe(7001);
            expect(readHeadlessHostConfig({ RISU_HEADLESS_HOST_PORT: blank, PORT: blank }, "/repo").port).toBe(6001);
        }
    });

    it("rejects noninteger and out-of-range ports with the selected variable's name", () => {
        for (const port of ["invalid", "6001.5", "0", "65536"]) {
            expect(() => readHeadlessHostConfig({ RISU_HEADLESS_HOST_PORT: port, PORT: "7001" }, "/repo")).toThrow(
                "RISU_HEADLESS_HOST_PORT",
            );
            expect(() => readHeadlessHostConfig({ RISU_HEADLESS_HOST_PORT: "", PORT: port }, "/repo")).toThrow(
                /\bPORT\b/,
            );
        }
    });

    it("accepts 64 code units and rejects longer or blank host names", () => {
        const name = "😀".repeat(32);
        expect(readHeadlessHostConfig({ RISU_HEADLESS_HOST_NAME: name }, "/repo").name).toBe(name);
        for (const invalid of [name + "x", "", "  "]) {
            expect(() => readHeadlessHostConfig({ RISU_HEADLESS_HOST_NAME: invalid }, "/repo")).toThrow();
        }
    });

    it("writes the default and configured host names as JSON localStorage preferences", () => {
        expect(readHeadlessHostConfig({}, "/repo")).toMatchObject({
            name: "Headless host",
            localStorageValues: {
                "risu-remote-host": "true",
                "risu-handoff-name": '"Headless host"',
            },
        });
        expect(readHeadlessHostConfig({ RISU_HEADLESS_HOST_NAME: 'Desk "A"' }, "/repo")).toMatchObject({
            name: 'Desk "A"',
            localStorageValues: {
                "risu-remote-host": "true",
                "risu-handoff-name": '"Desk \\"A\\""',
            },
        });
    });
    it("tries Chrome's install folders from Windows variables of any case, in Playwright's order", () => {
        const env = {
            "ProgramFiles(x86)": "C:\\Program Files (x86)",
            ProgramFiles: "C:\\Program Files",
            LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        };
        expect(readHeadlessHostConfig(env, "/repo", "win32").chromePaths).toEqual([
            "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]);
        expect(readHeadlessHostConfig({ ProgramFiles: " " }, "/repo", "win32").chromePaths).toEqual([]);
    });

    it("defaults to the macOS app bundle and the Linux launcher", () => {
        expect(readHeadlessHostConfig({}, "/repo", "darwin").chromePaths).toEqual([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]);
        expect(readHeadlessHostConfig({}, "/repo", "linux").chromePaths).toEqual(["/usr/bin/google-chrome"]);
    });

    it("uses a nonblank RISU_CHROME as the only Chrome path on every platform", () => {
        for (const platform of ["win32", "darwin", "linux"]) {
            const env = { RISU_CHROME: "/opt/chrome", LOCALAPPDATA: "C:\\Local" };
            expect(readHeadlessHostConfig(env, "/repo", platform).chromePaths).toEqual(["/opt/chrome"]);
            expect(readHeadlessHostConfig({ RISU_CHROME: " " }, "/repo", platform).chromePaths).toEqual(
                readHeadlessHostConfig({}, "/repo", platform).chromePaths,
            );
        }
    });

    it("reads mixed-case host settings on Windows and keeps other platforms case-sensitive", () => {
        const env = {
            Risu_Host: "127.0.0.2",
            Port: "7100",
            Risu_Chrome: "D:\\Tools\\Chrome\\chrome.exe",
            Risu_Headless_Host_Name: "Desk A",
            Risu_Headless_Host_Profile: "desk-profile",
            Risu_Headless_Host_Password: "example-password",
            Risu_Headless_Host_Console: "warn",
        };
        const uppercase = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
        const config = readHeadlessHostConfig(env, "/repo", "win32");
        expect(config).toMatchObject({
            host: "127.0.0.2",
            port: 7100,
            chromePaths: ["D:\\Tools\\Chrome\\chrome.exe"],
            name: "Desk A",
            profileDir: path.resolve("/repo", "desk-profile"),
            password: "example-password",
            consoleLevel: "warn",
        });
        expect(config).toEqual(readHeadlessHostConfig(uppercase, "/repo", "win32"));
        expect(readHeadlessHostConfig({ ...env, Risu_Headless_Host_Port: "7200" }, "/repo", "win32").port).toBe(7200);

        for (const platform of ["linux", "darwin"]) {
            expect(readHeadlessHostConfig(env, "/repo", platform)).toEqual(
                readHeadlessHostConfig({}, "/repo", platform),
            );
        }
    });

    it("prefers exact Windows environment keys over mixed-case duplicates, including blank values", () => {
        const env = {
            Risu_Headless_Host_Port: "7200",
            RISU_HEADLESS_HOST_PORT: " ",
            Port: "7100",
            PORT: "7101",
            Risu_Chrome: "D:\\Tools\\Chrome\\chrome.exe",
            RISU_CHROME: " ",
            ProgramFiles: "C:\\Other",
            PROGRAMFILES: "C:\\System",
            localAppData: "C:\\Local",
            "programFiles(x86)": "C:\\X86",
        };
        expect(readHeadlessHostConfig(env, "/repo", "win32")).toMatchObject({
            port: 7101,
            chromePaths: [
                "C:\\Local\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\System\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\X86\\Google\\Chrome\\Application\\chrome.exe",
            ],
        });
    });

    it("forwards console errors only by default, warnings with warn, and every type with all", () => {
        const level = (value?: string) =>
            readHeadlessHostConfig({ RISU_HEADLESS_HOST_CONSOLE: value }, "/repo", "linux").consoleLevel;
        expect([level(), level(" "), level("error"), level(" ALL "), level("warn")]).toEqual([
            "error",
            "error",
            "error",
            "all",
            "warn",
        ]);
        const logged = (value: string) =>
            ["error", "warning", "log", "debug"].filter((type) => consoleTypeLogged(value, type));
        expect(logged("error")).toEqual(["error"]);
        expect(logged("warn")).toEqual(["error", "warning"]);
        expect(logged("all")).toEqual(["error", "warning", "log", "debug"]);
        expect(() => level("verbose")).toThrow("RISU_HEADLESS_HOST_CONSOLE must be error, warn or all");
    });
});

describe("headless host restart timing", () => {
    it("starts at five seconds, doubles each restart, and stays capped at five minutes", () => {
        const waits = [RESTART_MIN_MS];
        for (let restart = 0; restart < 7; restart++) {
            waits.push(nextRestartWait(waits[waits.length - 1]));
        }
        expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    });

    it("resets to five seconds only after a full minute ready", () => {
        expect(resetRestartWait(300_000, 59_999)).toBe(300_000);
        expect(resetRestartWait(300_000, 60_000)).toBe(5_000);
        expect(resetRestartWait(300_000, 60_001)).toBe(5_000);
    });

    it("bounds plugins-off reloads after both safe-boot settling and the restart wait", () => {
        const settlingReload = pluginsOffReloadAt(100_000, 102_000, 5_000);
        expect(settlingReload).toBeGreaterThan(110_000);
        expect(settlingReload).toBeGreaterThanOrEqual(107_000);
        // Allow a margin without pinning its exact duration or permitting an unbounded wait.
        expect(settlingReload).toBeLessThanOrEqual(160_000);

        const backedOffReload = pluginsOffReloadAt(100_000, 160_000, 300_000);
        expect(backedOffReload).toBeGreaterThanOrEqual(460_000);
        expect(backedOffReload).toBeLessThanOrEqual(520_000);
    });
});

describe("redactCredentials", () => {
    it("removes the password and a URL query token from log text", () => {
        const text = redactCredentials(
            "host-secret failed at https://127.0.0.1:6001/?session=query-secret",
            "host-secret",
        );
        expect(text).not.toContain("host-secret");
        expect(text).not.toContain("query-secret");
    });

    it("keeps the path of the app's own origin without its query or fragment, and only the origin of any other URL", () => {
        const app = "http://127.0.0.1:6001";
        const redact = (text: string) => redactCredentials(text, "host-secret", app);
        expect(redact(`404 (${app}/api/asset/abc.png)`)).toBe(`404 (${app}/api/asset/abc.png)`);
        expect(redact(`at boot (${app}/assets/index-1a2b.js:12:345)`)).toBe(
            `at boot (${app}/assets/index-1a2b.js:12:345)`,
        );
        expect(redact(`${app}/api/read?session=query-secret#frag`)).toBe(`${app}/api/read[redacted]`);
        expect(redact(`${app}/x/host-secret/y`)).toBe(`${app}/x/[redacted]/y`);
        expect(redact("http://user:pw@127.0.0.1:6001/api/read")).toBe("http://127.0.0.1:6001/[redacted]");
        expect(redact("https://api.example.com/bot123:key/send")).toBe("https://api.example.com/[redacted]");
        expect(redact("http://127.0.0.1:6002/api/read")).toBe("http://127.0.0.1:6002/[redacted]");
        expect(redactCredentials(`${app}/api/read`, "host-secret")).toBe(`${app}/[redacted]`);
    });

    it("writes a console message's resource or script position after its text", () => {
        expect(consoleLocationText({ url: "http://127.0.0.1:6001/a.png", lineNumber: 0, columnNumber: 0 })).toBe(
            " at http://127.0.0.1:6001/a.png",
        );
        expect(consoleLocationText({ url: "http://127.0.0.1:6001/a.js", lineNumber: 11, columnNumber: 344 })).toBe(
            " at http://127.0.0.1:6001/a.js:12:345",
        );
        expect(consoleLocationText({ url: "", lineNumber: 0, columnNumber: 0 })).toBe("");
    });
});
