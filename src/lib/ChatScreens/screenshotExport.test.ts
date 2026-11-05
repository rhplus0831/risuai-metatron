import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
    composeScreenshot,
    MAX_EXPORT_PIXELS,
    MAX_EXPORT_SIDE,
    measureScreenshotRow,
    planScreenshotPages,
} from "./screenshotExport";

const baseName = "chat-11111111-2222-4333-8444-555555555555";
const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const row = (id: string, width: number, height: number) => ({ id, width, height, scaledDown: false });
type Row = ReturnType<typeof row>;

// happy-dom has no 2D context. Record allocations, draws and releases without allocating pixel buffers.
class FakeCanvas {
    readonly widthAssignments: number[] = [];
    readonly heightAssignments: number[] = [];
    readonly context = {
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn((source: HTMLCanvasElement, ..._coordinates: number[]) => {
            const captured = source as unknown as FakeCanvas;
            expect(captured.width).toBeGreaterThan(0);
            expect(captured.height).toBeGreaterThan(0);
            this.events.push(`draw:${captured.id}`);
        }),
    };
    readonly getContext = vi.fn((kind: string) => (kind === "2d" ? this.context : null));
    readonly toBlob = vi.fn((callback: BlobCallback, _type?: string) => {
        this.events.push(`encode:${this.id}`);
        callback(this.blob);
    });

    constructor(
        readonly id: string,
        readonly events: string[],
        private currentWidth = 300,
        private currentHeight = 150,
        readonly blob: Blob | null = png(),
    ) {}

    get width() {
        return this.currentWidth;
    }
    set width(value: number) {
        this.widthAssignments.push(value);
        this.events.push(`${this.id}.width=${value}`);
        this.currentWidth = value;
    }
    get height() {
        return this.currentHeight;
    }
    set height(value: number) {
        this.heightAssignments.push(value);
        this.events.push(`${this.id}.height=${value}`);
        this.currentHeight = value;
    }
    get element() {
        return this as unknown as HTMLCanvasElement;
    }
}

function exportIO(blobs: (Blob | null)[] = [png()]) {
    const events: string[] = [];
    const sources: FakeCanvas[] = [];
    const canvases: FakeCanvas[] = [];
    return {
        events,
        sources,
        canvases,
        capture: vi.fn(async (row: Row) => {
            expect(sources.filter((source) => source.width !== 0 || source.height !== 0)).toEqual([]);
            events.push(`capture:${row.id}`);
            const source = new FakeCanvas(row.id, events, row.width, row.height);
            sources.push(source);
            return source.element;
        }),
        createCanvas: () => {
            const canvas = new FakeCanvas(`page-${canvases.length + 1}`, events, 300, 150, blobs[canvases.length]);
            canvases.push(canvas);
            return canvas.element;
        },
        download: vi.fn(async (_name: string, _blob: Blob) => {}),
    };
}

let downloadFile: typeof import("src/ts/globalApi.svelte").downloadFile;
beforeAll(async () => {
    ({ downloadFile } = await import("src/ts/globalApi.svelte"));
});

afterEach(() => {
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

it("sizes a page once and releases each source after drawing it before capturing the next row", async () => {
    const rows = [row("a", 200, 40), row("b", 100, 30), row("c", 300, 20)];
    const blob = png();
    const io = exportIO([blob]);

    await composeScreenshot({ ...io, pages: planScreenshotPages(rows, (row) => row), baseName });

    expect(io.canvases).toHaveLength(1);
    const [page] = io.canvases;
    // Zeroing a canvas releases its buffer; only the nonzero assignments allocate the page.
    expect(page.widthAssignments.filter((value) => value !== 0)).toEqual([300]);
    expect(page.heightAssignments.filter((value) => value !== 0)).toEqual([90]);
    expect(io.sources).toHaveLength(3);
    for (const source of io.sources) {
        expect(source.widthAssignments).toEqual([0]);
        expect(source.heightAssignments).toEqual([0]);
    }
    expect(io.events.filter((event) => !event.includes("page-"))).toEqual([
        "capture:c",
        "draw:c",
        "c.width=0",
        "c.height=0",
        "capture:b",
        "draw:b",
        "b.width=0",
        "b.height=0",
        "capture:a",
        "draw:a",
        "a.width=0",
        "a.height=0",
    ]);
    expect(page.context.drawImage.mock.calls).toEqual([
        [io.sources[0].element, 0, 0],
        [io.sources[1].element, 0, 20],
        [io.sources[2].element, 0, 50],
    ]);
    expect(page.toBlob).toHaveBeenCalledExactlyOnceWith(expect.any(Function), "image/png");
    expect(io.download).toHaveBeenCalledExactlyOnceWith(`${baseName}.png`, blob);
    expect(io.download.mock.calls[0][1]).toBe(blob);
});

it.each([
    {
        limit: "pixel budget",
        rows: [row("a", 8000, 1), row("b", 1000, 4000), row("c", 8000, 4000)],
        expected: [
            {
                width: 8000,
                height: 8000,
                rows: [
                    ["c", 0, 8000, 4000],
                    ["b", 4000, 1000, 4000],
                ],
            },
            { width: 8000, height: 1, rows: [["a", 0, 8000, 1]] },
        ],
    },
    {
        limit: "side limit",
        rows: [row("a", 10, 1), row("b", 10, 8192), row("c", 10, 8192)],
        expected: [
            {
                width: 10,
                height: 16384,
                rows: [
                    ["c", 0, 10, 8192],
                    ["b", 8192, 10, 8192],
                ],
            },
            { width: 10, height: 1, rows: [["a", 0, 10, 1]] },
        ],
    },
])(
    "splits whole rows at the $limit in reverse DOM order and downloads one numbered PNG Blob per page",
    async ({ rows, expected }) => {
        expect(MAX_EXPORT_PIXELS).toBe(64_000_000);
        expect(MAX_EXPORT_SIDE).toBe(16_384);
        const pages = planScreenshotPages(rows, (row) => row);
        expect(
            pages.map((page) => ({
                width: page.width,
                height: page.height,
                rows: page.rows.map((slot) => [slot.row.id, slot.y, slot.width, slot.height]),
            })),
        ).toEqual(expected);
        for (const page of pages) {
            expect(page.width * page.height).toBeLessThanOrEqual(64_000_000);
            expect(page.width).toBeLessThanOrEqual(16_384);
            expect(page.height).toBeLessThanOrEqual(16_384);
        }

        const blobs = [png(), png()];
        const io = exportIO(blobs);
        await composeScreenshot({ ...io, pages, baseName });

        expect(io.capture.mock.calls.map(([row]) => row.id)).toEqual(["c", "b", "a"]);
        expect(io.canvases).toHaveLength(2);
        for (const [index, canvas] of io.canvases.entries()) {
            expect(canvas.widthAssignments.filter((value) => value !== 0)).toEqual([expected[index].width]);
            expect(canvas.heightAssignments.filter((value) => value !== 0)).toEqual([expected[index].height]);
            expect(canvas.toBlob).toHaveBeenCalledExactlyOnceWith(expect.any(Function), "image/png");
        }
        expect(io.download.mock.calls).toEqual([
            [`${baseName}-1of2.png`, blobs[0]],
            [`${baseName}-2of2.png`, blobs[1]],
        ]);
        expect(io.download.mock.calls[0][1]).toBe(blobs[0]);
        expect(io.download.mock.calls[1][1]).toBe(blobs[1]);
    },
);

it.each([
    { side: "tall", width: 1000, height: 20000, scaledWidth: 819, scaledHeight: 16384 },
    { side: "wide", width: 20000, height: 1000, scaledWidth: 16384, scaledHeight: 819 },
])("gives a $side autoscaled row its own page at its measured size", ({ width, height, scaledWidth, scaledHeight }) => {
    // html-to-image reads the environment override before window.devicePixelRatio.
    vi.stubEnv("devicePixelRatio", "2");
    const node = (width: number, height: number) => {
        const node = document.createElement("div");
        Object.defineProperties(node, { clientWidth: { value: width }, clientHeight: { value: height } });
        return node;
    };
    const before = node(2, 5);
    const oversized = node(width, height);
    const after = node(3, 4);

    expect(measureScreenshotRow(before)).toEqual({ width: 4, height: 10, scaledDown: false });
    expect(measureScreenshotRow(oversized)).toEqual({ width: scaledWidth, height: scaledHeight, scaledDown: true });
    expect(planScreenshotPages([before, oversized, after], measureScreenshotRow)).toEqual([
        { width: 6, height: 8, rows: [{ row: after, y: 0, width: 6, height: 8 }] },
        {
            width: scaledWidth,
            height: scaledHeight,
            rows: [{ row: oversized, y: 0, width: scaledWidth, height: scaledHeight }],
        },
        { width: 4, height: 10, rows: [{ row: before, y: 0, width: 4, height: 10 }] },
    ]);
});

it("clips a capture taller than its measured slot and emits one console warning", async () => {
    const growing = row("growing", 10, 4);
    const pages = planScreenshotPages([growing, row("preceding", 10, 3)], (row) => row);
    growing.height = 8;
    const io = exportIO();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await composeScreenshot({ ...io, pages, baseName });

    expect(io.canvases[0].context.drawImage).toHaveBeenNthCalledWith(
        2,
        io.sources[1].element,
        0,
        0,
        10,
        4,
        0,
        3,
        10,
        4,
    );
    expect(io.canvases[0].context.drawImage).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
});

it.each([
    { result: "a null", blob: null },
    { result: "an empty", blob: new Blob([], { type: "image/png" }) },
])("rejects $result PNG Blob without downloading it", async ({ blob }) => {
    const io = exportIO([blob]);
    const pages = planScreenshotPages([row("a", 10, 10)], (row) => row);

    await expect(composeScreenshot({ ...io, pages, baseName })).rejects.toThrow();

    expect(io.canvases[0].toBlob).toHaveBeenCalledExactlyOnceWith(expect.any(Function), "image/png");
    expect(io.download).not.toHaveBeenCalled();
});

it("passes the original Blob to URL.createObjectURL when downloading a file", async () => {
    vi.useFakeTimers();
    const blob = png();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:screenshot");
    const links: string[][] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        links.push([this.download, this.href]);
    });

    await downloadFile(`${baseName}.png`, blob);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBe(blob);
    expect(links).toEqual([[`${baseName}.png`, "blob:screenshot"]]);
});
