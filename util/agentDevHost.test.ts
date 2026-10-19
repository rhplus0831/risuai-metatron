// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { isTailscaleIpv4, resolveAgentDevHost } from "./agentDevHost.mjs";

describe("resolveAgentDevHost", () => {
    it("binds to 127.0.0.1 when nothing is configured, without asking Tailscale", () => {
        const lookup = vi.fn(() => "100.100.1.1");
        expect(resolveAgentDevHost(undefined, lookup)).toEqual({ host: "127.0.0.1", source: "loopback" });
        expect(resolveAgentDevHost("  ", lookup)).toEqual({ host: "127.0.0.1", source: "loopback" });
        expect(lookup).not.toHaveBeenCalled();
    });

    it("binds a configured address as it is", () => {
        expect(resolveAgentDevHost(" 192.168.1.10 ", () => undefined)).toEqual({
            host: "192.168.1.10",
            source: "configured",
        });
        expect(resolveAgentDevHost("::1", () => undefined)).toEqual({ host: "::1", source: "configured" });
    });

    it("refuses a bracketed IPv6 address", () => {
        expect(() => resolveAgentDevHost("[::1]", () => undefined)).toThrow("without brackets");
    });

    it("looks the Tailscale address up for `tailscale`", () => {
        expect(resolveAgentDevHost("Tailscale", () => "100.126.236.83")).toEqual({
            host: "100.126.236.83",
            source: "tailscale",
        });
    });

    it.each([undefined, "192.168.1.10"])("fails for `tailscale` when the lookup gives %j", (address) => {
        expect(() => resolveAgentDevHost("tailscale", () => address)).toThrow("no Tailscale IPv4 address");
    });
});

describe("isTailscaleIpv4", () => {
    it.each(["100.64.0.1", "100.127.255.254", "100.100.100.100"])("accepts %j", (host) => {
        expect(isTailscaleIpv4(host)).toBe(true);
    });

    it.each(["100.63.255.255", "100.128.0.1", "10.0.0.1", "fd7a:115c:a1e0::1", "tailscale"])("refuses %j", (host) => {
        expect(isTailscaleIpv4(host)).toBe(false);
    });
});
