import { afterEach, describe, expect, it, vi } from "vitest";
import { importCharxOverServer } from "../charxImportClient";
import { authFetch } from "../serverAuth";
import { ServerImportAnswerError } from "../serverImportClient";

vi.mock("../serverAuth", () => ({ authFetch: vi.fn() }));

const line = (value: unknown) => JSON.stringify(value) + "\n";
const result = {
    card: '{"name":"캐릭터 🎵"}',
    moduleData: "AP+A",
    assets: { "assets/표정.webp": "assets/fixture.png" },
    excluded: ["too-big.webp"],
};

afterEach(() => {
    vi.resetAllMocks();
});

describe("importCharxOverServer", () => {
    it.each([0, 2])(
        "uploads the original Blob once and streams %i progress lines before the UTF-8 result",
        async (count) => {
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            vi.mocked(authFetch).mockResolvedValue(
                new Response(new ReadableStream({ start: (c) => (controller = c) })),
            );
            const file = new Blob(["opaque CharX bytes"]);
            const onProgress = vi.fn();
            let settled = false;
            const importing = importCharxOverServer(file, { onProgress }).finally(() => (settled = true));
            const encoder = new TextEncoder();
            for (let done = 1; done <= count; done++) {
                const bytes = encoder.encode(line({ done, total: count }));
                controller.enqueue(bytes.slice(0, 5));
                controller.enqueue(bytes.slice(5));
                await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(done));
                expect(onProgress).toHaveBeenNthCalledWith(done, done, count);
                expect(settled).toBe(false);
            }
            const answer = count ? result : { card: null, moduleData: null, assets: {}, excluded: [] };
            const bytes = encoder.encode(line(answer));
            const split = count ? bytes.indexOf(encoder.encode("캐")[0]) + 1 : 5;
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
            expect(await importing).toEqual(answer);
            expect(onProgress).toHaveBeenCalledTimes(count);
            expect(authFetch).toHaveBeenCalledExactlyOnceWith("/api/import/charx", {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: file,
            });
            expect(vi.mocked(authFetch).mock.calls[0][1].body).toBe(file);
        },
    );

    it.each([
        ["non-JSON", "bad\n"],
        ["non-object", "[]\n"],
        ["unknown line", line({ other: true })],
        ["missing result", line({ done: 1, total: 1 })],
        ["unfinished result", JSON.stringify(result)],
        ["line after result", line(result) + line({ done: 1, total: 1 })],
        ["missing assets discriminator", line({ card: null, moduleData: null, excluded: [] })],
        // The result line's shape: each field checked once (the shared reader's other failures are
        // covered by `moduleImportClient.test.ts`).
        ...[
            ["card", 3],
            ["moduleData", {}],
            ["assets", { image: 1 }],
            ["excluded", [1]],
        ].map(([field, value]) => [
            `invalid ${field}: ${JSON.stringify(value)}`,
            line({ ...result, [field as string]: value }),
        ]),
    ])("rejects a malformed answer: %s", async (_name, body) => {
        vi.mocked(authFetch).mockResolvedValue(new Response(body));
        await expect(importCharxOverServer(new Blob())).rejects.toBeInstanceOf(ServerImportAnswerError);
        expect(authFetch).toHaveBeenCalledTimes(1);
    });
});
