// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doLossyCompression } from "../lossyCompression";

let image: { width: number; height: number; src: string; onload?: () => void };
const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");

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
    if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
    else Reflect.deleteProperty(globalThis, "Image");
});

describe("doLossyCompression", () => {
    it("labels decoded bytes with their detected MIME and retains WebP/JPEG quality and aspect-ratio resizing", async () => {
        const formats: [string, number[]][] = [
            ["image/jpeg", [0xff, 0xd8, 0, 0xff, 0xd9]],
            ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
            ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
            ["image/bmp", [0x42, 0x4d, 0, 0]],
            ["application/octet-stream", [1, 2, 3]],
        ];
        const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
        const draw = vi.fn<CanvasRenderingContext2D["drawImage"]>();
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
            drawImage: draw,
        } as unknown as CanvasRenderingContext2D);
        for (const [mime, bytes] of formats) {
            encode.mockReset();
            const fallback = mime === "image/jpeg";
            encode.mockReturnValueOnce(fallback ? "data:image/png;base64,AQID" : "data:image/webp;base64,AQID");
            if (fallback) encode.mockReturnValueOnce("data:image/jpeg;base64,AQID");
            image.width = 6000;
            image.height = 4000;
            const input = new Uint8Array(bytes);
            const work = doLossyCompression(input);
            expect(image.src).toBe(`data:${mime};base64,${Buffer.from(input).toString("base64")}`);
            image.onload!();
            expect(await work).toEqual(Buffer.from([1, 2, 3]));
            expect(draw).toHaveBeenLastCalledWith(image, 0, 0, 3000, 2000);
            expect(encode.mock.calls).toEqual(
                fallback
                    ? [
                          ["image/webp", 0.75],
                          ["image/jpeg", 0.75],
                      ]
                    : [["image/webp", 0.75]],
            );
        }
    });

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
