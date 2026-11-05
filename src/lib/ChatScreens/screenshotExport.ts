/**
 * Plans the chat screenshot as pages of whole rows in reverse DOM order and composes each page.
 * Pages contain at most MAX_EXPORT_PIXELS pixels and measure at most MAX_EXPORT_SIDE on either
 * side, unless a row alone exceeds the pixel budget. A row gets its own page if it exceeds that
 * budget or html-to-image scales it down. Rows are never split.
 *
 * Each page canvas is sized once. Only one row canvas is alive at a time, and its size is zeroed
 * after its draw. Each page is filled with the passed background color. The page canvas is released
 * before the next page, also on failure.
 *
 * Each page sends one PNG Blob to `download`. An empty plan, a null Blob, or an empty Blob is an error.
 */
import { getImageSize, getPixelRatio } from "html-to-image/es/util.js";
import { SCREENSHOT_CAPTURE_OPTIONS } from "./screenshotCapture";

export const MAX_EXPORT_PIXELS = 64_000_000;
export const MAX_EXPORT_SIDE = 16_384;

export interface ScreenshotCaptureSize {
    width: number;
    height: number;
    scaledDown: boolean;
}

export interface ScreenshotRowSlot<Row> {
    row: Row;
    y: number;
    width: number;
    height: number;
}

export interface ScreenshotPage<Row> {
    rows: ScreenshotRowSlot<Row>[];
    width: number;
    height: number;
}

/** Matches html-to-image's toCanvas sizing, including truncation at each canvas dimension assignment. */
export function measureScreenshotRow(node: HTMLElement): ScreenshotCaptureSize {
    const size = getImageSize(node, SCREENSHOT_CAPTURE_OPTIONS);
    const ratio = getPixelRatio();
    let width = Math.trunc(size.width * ratio);
    let height = Math.trunc(size.height * ratio);
    const scaledDown = width > MAX_EXPORT_SIDE || height > MAX_EXPORT_SIDE;

    if (scaledDown) {
        if (width > MAX_EXPORT_SIDE && height > MAX_EXPORT_SIDE) {
            if (width > height) {
                height = Math.trunc(height * (MAX_EXPORT_SIDE / width));
                width = MAX_EXPORT_SIDE;
            } else {
                width = Math.trunc(width * (MAX_EXPORT_SIDE / height));
                height = MAX_EXPORT_SIDE;
            }
        } else if (width > MAX_EXPORT_SIDE) {
            height = Math.trunc(height * (MAX_EXPORT_SIDE / width));
            width = MAX_EXPORT_SIDE;
        } else {
            width = Math.trunc(width * (MAX_EXPORT_SIDE / height));
            height = MAX_EXPORT_SIDE;
        }
    }

    return { width, height, scaledDown };
}

/** Keeps rows whole in reverse DOM order; zero-sized captures are omitted because drawImage rejects them. */
export function planScreenshotPages<Row>(
    rows: Iterable<Row>,
    measure: (row: Row) => ScreenshotCaptureSize,
): ScreenshotPage<Row>[] {
    const pages: ScreenshotPage<Row>[] = [];
    let page: ScreenshotPage<Row> | undefined;

    for (const row of Array.from(rows).reverse()) {
        const { width, height, scaledDown } = measure(row);
        if (width === 0 || height === 0) continue;

        const alone = scaledDown || width * height > MAX_EXPORT_PIXELS;
        const nextWidth = Math.max(page?.width ?? 0, width);
        const nextHeight = (page?.height ?? 0) + height;
        if (
            !page ||
            alone ||
            nextWidth > MAX_EXPORT_SIDE ||
            nextHeight > MAX_EXPORT_SIDE ||
            nextWidth * nextHeight > MAX_EXPORT_PIXELS
        ) {
            page = { rows: [], width: 0, height: 0 };
            pages.push(page);
        }

        page.rows.push({ row, y: page.height, width, height });
        page.width = Math.max(page.width, width);
        page.height += height;
        if (alone) page = undefined;
    }

    return pages;
}

export interface ScreenshotComposeOptions<Row> {
    pages: readonly ScreenshotPage<Row>[];
    capture(row: Row): Promise<HTMLCanvasElement>;
    createCanvas(): HTMLCanvasElement;
    download(name: string, blob: Blob): Promise<void>;
    baseName: string;
    background: string;
    onProgress?(done: number, total: number): void;
    warn?(message: string): void;
}

export async function composeScreenshot<Row>({
    pages,
    capture,
    createCanvas,
    download,
    baseName,
    background,
    onProgress,
    warn = console.warn,
}: ScreenshotComposeOptions<Row>): Promise<void> {
    if (pages.length === 0) throw new Error("No screenshot rows to export");
    const total = pages.reduce((count, page) => count + page.rows.length, 0);
    let done = 0;

    for (const [index, page] of pages.entries()) {
        const canvas = createCanvas();
        try {
            canvas.width = page.width;
            canvas.height = page.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Screenshot canvas context is unavailable");
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, page.width, page.height);

            for (const slot of page.rows) {
                const source = await capture(slot.row);
                try {
                    if (source.width !== slot.width || source.height !== slot.height) {
                        warn(
                            `Screenshot capture size changed: ${source.width}x${source.height}, expected ${slot.width}x${slot.height}`,
                        );
                        const width = Math.min(source.width, slot.width);
                        const height = Math.min(source.height, slot.height);
                        ctx.drawImage(source, 0, 0, width, height, 0, slot.y, width, height);
                    } else {
                        ctx.drawImage(source, 0, slot.y);
                    }
                } finally {
                    source.width = 0;
                    source.height = 0;
                }
                done++;
                onProgress?.(done, total);
            }

            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
            if (!blob || blob.size === 0) throw new Error("Screenshot PNG encoding failed");
            const name = pages.length === 1 ? `${baseName}.png` : `${baseName}-${index + 1}of${pages.length}.png`;
            await download(name, blob);
        } finally {
            canvas.width = 0;
            canvas.height = 0;
        }
    }
}
