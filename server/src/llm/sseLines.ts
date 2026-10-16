/** Incremental UTF-8 lines for one SSE response body; only the unfinished line is retained. */
export class SseLines {
    private readonly decoder = new TextDecoder();
    private buffer = "";

    private takeLines(text: string): string[] {
        // Split only the newly decoded text, without rescanning the unfinished prefix.
        const lines = text.split("\n");
        lines[0] = this.buffer + lines[0];
        this.buffer = lines.pop() ?? "";
        return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    }

    push(bytes: Uint8Array): string[] {
        return this.takeLines(this.decoder.decode(bytes, { stream: true }));
    }

    end(): string[] {
        const lines = this.takeLines(this.decoder.decode());
        if (this.buffer) {
            lines.push(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
            this.buffer = "";
        }
        return lines;
    }
}
