import { vi } from "vitest";

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

// Suppress warning
vi.mock(import("katex"), () => ({}));

vi.stubGlobal("safeStructuredClone", (v: unknown) => JSON.parse(JSON.stringify(v)));
