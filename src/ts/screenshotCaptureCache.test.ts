import { Buffer } from "buffer";
import { resourceToDataURL } from "html-to-image/lib/dataurl.js";
import { SCREENSHOT_CAPTURE_OPTIONS } from "src/lib/ChatScreens/screenshotCapture";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
});

it("fetches and embeds the original and each thumbnail size separately after a thumbnail capture", async () => {
    const asset = `https://app.test/api/asset/${Buffer.from("assets/screenshot-cache-portrait.png", "utf8").toString("hex")}`;
    const images = [
        { url: `${asset}?w=512`, bytes: "thumbnail 512 bytes", contentType: "image/webp" },
        { url: asset, bytes: "original bytes", contentType: "image/png" },
        { url: `${asset}?w=256`, bytes: "thumbnail 256 bytes", contentType: "image/webp" },
    ];
    const requestedUrls: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
            const url = String(input);
            requestedUrls.push(url);
            const image = images.find((image) => image.url === url);
            if (!image) throw new Error(`Unexpected asset URL: ${url}`);
            return new Response(image.bytes, { headers: { "Content-Type": image.contentType } });
        }),
    );

    for (const image of images) {
        const embedded = await resourceToDataURL(image.url, "", SCREENSHOT_CAPTURE_OPTIONS);
        expect.soft(embedded).toBe(`data:${image.contentType};base64,${Buffer.from(image.bytes).toString("base64")}`);
    }
    expect(requestedUrls).toEqual(expect.arrayContaining(images.map((image) => image.url)));
});
