// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doLossyCompression } from "../lossyCompression";

let image: { width: number; height: number; src: string; onload?: () => void };

beforeEach(() => {
    image = { width: 16, height: 16, src: "" };
    vi.stubGlobal("Image", function () {
        return image;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("doLossyCompression", () => {
    it("encodes WebP with canvas quality 0.75", async () => {
        const toDataURL = vi
            .spyOn(HTMLCanvasElement.prototype, "toDataURL")
            .mockReturnValue("data:image/webp;base64,AQID");

        const compressed = doLossyCompression(new Uint8Array([1, 2, 3]));
        image.onload!();
        await compressed;

        expect(toDataURL).toHaveBeenCalledExactlyOnceWith("image/webp", 0.75);
    });

    it("encodes the JPEG fallback with canvas quality 0.75 when WebP is unsupported", async () => {
        const toDataURL = vi
            .spyOn(HTMLCanvasElement.prototype, "toDataURL")
            .mockReturnValueOnce("data:image/png;base64,AQID")
            .mockReturnValueOnce("data:image/jpeg;base64,AQID");

        const compressed = doLossyCompression(new Uint8Array([1, 2, 3]));
        image.onload!();
        await compressed;

        expect(toDataURL).toHaveBeenCalledTimes(2);
        expect(toDataURL).toHaveBeenCalledWith("image/webp", 0.75);
        expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.75);
    });
});
