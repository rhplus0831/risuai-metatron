// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
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
});
