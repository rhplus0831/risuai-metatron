import { afterEach, describe, expect, it, vi } from "vitest";
import {
    importModuleOverServer,
    ModuleImportAnswerError,
    ModuleImportFailedError,
    ModuleImportRequestError,
} from "../moduleImportClient";
import { authFetch } from "../serverAuth";

vi.mock("../serverAuth", () => ({ authFetch: vi.fn() }));

const encoder = new TextEncoder();
const line = (value: unknown) => JSON.stringify(value) + "\n";
const result = {
    module: { id: "file-id", name: "모듈", assets: [] },
    assetsWritten: 0,
    assetsSkipped: 0,
};

afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
});

describe("importModuleOverServer", () => {
    it.each([0, 2])("streams %i progress lines and a UTF-8 result using the original Blob once", async (count) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (value) => (controller = value) });
        vi.mocked(authFetch).mockResolvedValue(new Response(body));
        const file = new Blob(["opaque file bytes"]);
        const onProgress = vi.fn();
        let settled = false;
        const importing = importModuleOverServer(file, { onProgress }).finally(() => (settled = true));

        for (let done = 1; done <= count; done++) {
            // A progress line straddles chunks; its callback must run before the result is available.
            const bytes = encoder.encode(line({ done, total: count }));
            controller.enqueue(bytes.slice(0, 5));
            controller.enqueue(bytes.slice(5));
            await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(done));
            expect(onProgress).toHaveBeenNthCalledWith(done, done, count);
            expect(settled).toBe(false);
        }

        const answer = { ...result, assetsWritten: count };
        const bytes = encoder.encode(line(answer));
        const split = bytes.indexOf(encoder.encode("모")[0]) + 1;
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
        expect(await importing).toEqual(answer);
        expect(onProgress).toHaveBeenCalledTimes(count);
        expect(authFetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(authFetch).mock.calls[0];
        expect(url).toBe("/api/import/module");
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream");
        expect(init.body).toBe(file);
    });

    it.each([
        ["non-JSON line", "not JSON\n"],
        ["line after result", line(result) + line({ done: 1, total: 1 })],
        ["no result", line({ done: 1, total: 1 })],
        ["unfinished line", JSON.stringify(result)],
    ])("rejects a malformed 2xx answer: %s", async (_name, body) => {
        vi.mocked(authFetch).mockResolvedValue(new Response(body));
        await expect(importModuleOverServer(new Blob())).rejects.toBeInstanceOf(ModuleImportAnswerError);
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            name: "HTTP JSON error",
            response: () => Response.json({ error: "Busy" }, { status: 429 }),
            status: 429,
            serverError: "Busy",
        },
        {
            name: "HTTP non-JSON error",
            response: () => new Response("<html>proxy failure</html>", { status: 502 }),
            status: 502,
            serverError: null,
        },
        { name: "failure line", response: () => new Response(line({ error: "Disk full" })), message: "Disk full" },
        { name: "fetch TypeError", network: "fetch" },
        { name: "body TypeError", network: "body" },
    ])("preserves the failure type without retrying: $name", async (testCase) => {
        vi.useFakeTimers();
        const disconnected = new TypeError("connection lost");
        if (testCase.network === "fetch") {
            vi.mocked(authFetch).mockRejectedValue(disconnected);
        } else if (testCase.network === "body") {
            vi.mocked(authFetch).mockResolvedValue(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.error(disconnected);
                        },
                    }),
                ),
            );
        } else {
            vi.mocked(authFetch).mockImplementation(async () => testCase.response!());
        }
        let failure: unknown;
        const importing = importModuleOverServer(new Blob()).catch((error) => (failure = error));
        await vi.advanceTimersByTimeAsync(180_000);
        if (testCase.network) {
            expect(failure).toBe(disconnected);
        } else if (testCase.status) {
            expect(failure).toBeInstanceOf(ModuleImportRequestError);
            expect(failure).toMatchObject({ status: testCase.status, serverError: testCase.serverError });
        } else {
            expect(failure).toBeInstanceOf(ModuleImportFailedError);
            expect(failure).toMatchObject({ message: testCase.message });
        }
        expect(authFetch).toHaveBeenCalledTimes(1);
        await importing;
    });
});
