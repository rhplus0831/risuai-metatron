import { afterAll, afterEach, vi } from "vitest";
import { testNetwork } from "./vitest.testNetwork.ts";

// Test-only shim for happy-dom's `Node.prototype.nodeName`.
//
// happy-dom's base getter (happy-dom/lib/nodes/node/Node.js) returns "" and relies on
// Element, Text, Comment, Document and DocumentType overriding it. DOMPurify >= 3.4.6 does not
// read `node.nodeName`; it captures the getter from `Node.prototype` once per instance
// (`lookupGetter(Node.prototype, "nodeName")` in dompurify/dist/purify.es.mjs) and calls that,
// so under happy-dom every element's tag name reads as "": BODY and every allowed tag are
// removed, later siblings are never visited, and forbidden attributes such as `onerror` can
// survive. Upstream: https://github.com/capricorn86/happy-dom/issues/2182.
//
// The shim makes the prototype getter dispatch by node type, as the DOM spec defines nodeName.
// It runs synchronously here because DOMPurify captures the getter when its default instance is
// created at module evaluation; a setup import that pulls in dompurify would run before this
// body, so this file must not import application code.
//
// Remove it once the installed happy-dom returns the element tag name from
// `Object.getOwnPropertyDescriptor(Node.prototype, "nodeName").get.call(document.createElement("div"))`;
// the guard below then leaves the prototype untouched and this block is dead code.
installHappyDomNodeNameShim(globalThis.window);

function installHappyDomNodeNameShim(win: (Window & typeof globalThis) | undefined) {
    // Files that opt into `@vitest-environment node` have no window and nothing to patch.
    if (!win?.Node || !win.document) {
        return;
    }
    const nodeProto = win.Node.prototype;
    const desc = Object.getOwnPropertyDescriptor(nodeProto, "nodeName");
    if (!desc?.get) {
        return;
    }
    if (desc.get.call(win.document.createElement("div")) === "DIV") {
        return;
    }

    const getter = <T>(proto: object, prop: string): ((this: T) => unknown) => {
        const get = Object.getOwnPropertyDescriptor(proto, prop)?.get;
        if (!get) {
            throw new Error(`happy-dom nodeName shim: ${prop} getter not found`);
        }
        return get;
    };
    const getNodeType = getter<Node>(nodeProto, "nodeType");
    const getElementName = getter<Element>(win.Element.prototype, "nodeName");
    const getAttrName = getter<Attr>(win.Attr.prototype, "name");
    const getTarget = getter<ProcessingInstruction>(win.ProcessingInstruction.prototype, "target");
    const getDoctypeName = getter<DocumentType>(win.DocumentType.prototype, "name");

    Object.defineProperty(nodeProto, "nodeName", {
        configurable: true,
        enumerable: desc.enumerable,
        get(this: Node) {
            switch (getNodeType.call(this)) {
                case 1:
                    return getElementName.call(this as Element);
                case 2:
                    return getAttrName.call(this as unknown as Attr);
                case 3:
                    return "#text";
                case 4:
                    return "#cdata-section";
                case 7:
                    return getTarget.call(this as ProcessingInstruction);
                case 8:
                    return "#comment";
                case 9:
                    return "#document";
                case 10:
                    return getDoctypeName.call(this as DocumentType);
                case 11:
                    return "#document-fragment";
                default:
                    throw new TypeError("Illegal invocation");
            }
        },
    });
}

await installTestNetworkGuard();

// Routes the global `fetch`, `WebSocket`, Node's undici dispatcher, and happy-dom's loader through
// `vitest.testNetwork.ts`. The globals are assigned directly, not with `vi.stubGlobal`, so
// `vi.unstubAllGlobals()` restores the guard rather than the unguarded original.
async function installTestNetworkGuard() {
    // Each guard keeps its original here, so a second setup run (globals or happy-dom's modules
    // outliving a test file's module graph) wraps the original, not an earlier guard bound to an
    // earlier policy.
    const realKey = Symbol.for("risu.testNetwork.real");
    const unwrap = <T extends object>(value: T | undefined): T | undefined =>
        (value && (Reflect.get(value, realKey) as T | undefined)) ?? value;
    const keepOriginal = <T extends object>(guard: T, original: T): T =>
        Object.defineProperty(guard, realKey, { value: original });
    const guardWebSocket = (RealWebSocket: typeof WebSocket) => {
        const GuardedWebSocket = class extends RealWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                testNetwork.check(url);
                super(url, protocols);
            }
        };
        return keepOriginal(GuardedWebSocket, RealWebSocket);
    };

    const realFetch = unwrap(globalThis.fetch);
    if (realFetch) {
        // Rejects like a failed request instead of throwing synchronously.
        const guardedFetch: typeof fetch = async (input, init) => {
            testNetwork.check(input);
            return realFetch(input, init);
        };
        globalThis.fetch = keepOriginal(guardedFetch, realFetch);
    }

    const RealWebSocket = unwrap(globalThis.WebSocket);
    if (RealWebSocket) {
        globalThis.WebSocket = guardWebSocket(RealWebSocket);
    }

    // Node's fetch (undici) follows redirects internally, past the guard above; its global dispatcher
    // sees every hop, so a redirect to a refused origin fails too. Node's own `WebSocket` handshake
    // goes through it as well. The connection goes to `origin`; `path` never changes the host.
    type Dispatcher = { dispatch(options: { origin?: string | URL; path: string }, handler: unknown): boolean };
    const dispatcherKey = Symbol.for("undici.globalDispatcher.1");
    const dispatcher = unwrap(Reflect.get(globalThis, dispatcherKey) as Dispatcher | undefined);
    if (dispatcher) {
        const guardedDispatch: Dispatcher["dispatch"] = (options, handler) => {
            testNetwork.check(
                options.origin ? `${new URL(String(options.origin)).origin}${options.path}` : options.path,
            );
            return dispatcher.dispatch(options, handler);
        };
        const guardedDispatcher = new Proxy(dispatcher, {
            get(target, prop) {
                if (prop === realKey) return target;
                if (prop === "dispatch") return guardedDispatch;
                const value: unknown = Reflect.get(target, prop, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        Reflect.set(globalThis, dispatcherKey, guardedDispatcher);
    }

    // happy-dom (`node` environment files have none). Every async request its windows send (fetch,
    // XHR, script, link, and iframe loads, each redirect hop) is a `Fetch` and every sync XHR a
    // `SyncFetch`; both are checked as `send` starts, so a refusal rejects (or throws) as a failed
    // request would. Not through `settings.fetch.interceptor`: happy-dom 20.14.5 starts an async task
    // before `beforeAsyncRequest` and ends it only when the hook returns, so a refusal thrown there
    // would leave `happyDOM.waitUntilComplete()` pending. The window Vitest installed was built
    // before this runs and gets the global guards above; a window built later (an iframe's, or
    // `window.open`'s) gets its `WebSocket` guarded as happy-dom builds its classes.
    if ("happyDOM" in globalThis) {
        type Send<R> = (this: { request: { url: string } }) => R;
        const [{ default: Fetch }, { default: SyncFetch }, { default: WindowContextClassExtender }] = await Promise.all(
            [
                import("happy-dom/lib/fetch/Fetch.js"),
                import("happy-dom/lib/fetch/SyncFetch.js"),
                import("happy-dom/lib/window/WindowContextClassExtender.js"),
            ],
        );
        const send = unwrap(Fetch.prototype.send as Send<Promise<unknown>>)!;
        Fetch.prototype.send = keepOriginal<Send<Promise<unknown>>>(async function () {
            testNetwork.check(this.request.url);
            return send.call(this);
        }, send) as typeof Fetch.prototype.send;
        const syncSend = unwrap(SyncFetch.prototype.send as Send<unknown>)!;
        SyncFetch.prototype.send = keepOriginal<Send<unknown>>(function () {
            testNetwork.check(this.request.url);
            return syncSend.call(this);
        }, syncSend) as typeof SyncFetch.prototype.send;
        const extendClasses = unwrap(WindowContextClassExtender.extendClasses);
        if (extendClasses) {
            WindowContextClassExtender.extendClasses = keepOriginal(function (
                this: typeof WindowContextClassExtender,
                window: Parameters<typeof extendClasses>[0],
            ) {
                extendClasses.call(this, window);
                Reflect.set(
                    window,
                    "WebSocket",
                    guardWebSocket(Reflect.get(window, "WebSocket") as unknown as typeof WebSocket),
                );
            }, extendClasses);
        }
    }

    // A test whose code caught a refused request still fails.
    afterEach(() => testNetwork.finish());
    // Runs after the file's own `afterAll` hooks, which close the servers they registered. It also
    // reports a refusal no `afterEach` saw (in `onTestFinished` or the file's `afterAll`).
    afterAll(() => {
        const problems: string[] = [];
        try {
            testNetwork.finish();
        } catch (error) {
            problems.push((error as Error).message);
        }
        const left = testNetwork.registeredOrigins();
        if (left.length) {
            problems.push(`Loopback origins still registered after the file's tests: ${left.join(", ")}`);
        }
        if (problems.length) throw new Error(problems.join("\n"));
    });
}

// Suppress warning
vi.mock(import("katex"), () => ({}));

vi.stubGlobal("safeStructuredClone", (v: unknown) => JSON.parse(JSON.stringify(v)));
