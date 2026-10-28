/** A controllable browser socket for live-update tests. */
export class FakeSocket {
    static instances: FakeSocket[] = [];
    readonly url: string;
    closed = false;
    /** A socket whose `close()` fires no `close` event (a dead link: the event comes late, or never). */
    silent = false;
    private listeners = new Map<string, ((event: any) => void)[]>();
    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }
    addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    open() {
        this.emit("open", {});
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (!this.silent) {
            this.emit("close", {});
        }
    }
    emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
    frame(value: unknown) {
        this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
    }
}
