import { describe, it, expect } from "vitest";
import DOMPurify from "dompurify";

// Pins the contract of the happy-dom `Node.prototype.nodeName` shim in vitest.setup.ts. DOMPurify
// reads node names through the prototype getter, not through `node.nodeName`, so every assertion
// here goes through the getter the same way. The suite must keep passing unchanged once happy-dom
// fixes capricorn86/happy-dom#2182 and the shim becomes a no-op.

const nodeNameGetter = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")?.get;
const readNodeName = (node: unknown) => nodeNameGetter?.call(node);

// Same lookup DOMPurify uses: the first own descriptor up the prototype chain.
const lookupGetter = (object: object | null, prop: string) => {
    while (object !== null) {
        const desc = Object.getOwnPropertyDescriptor(object, prop);
        if (desc?.get) return desc.get;
        if (typeof desc?.value === "function") return desc.value as (...args: unknown[]) => unknown;
        object = Object.getPrototypeOf(object);
    }
    return undefined;
};

describe("happy-dom Node.prototype.nodeName shim", () => {
    const doc = new DOMParser().parseFromString(
        '<!DOCTYPE html><html><body><div id="a" data-x="1">t<!--c--></div><svg><foreignObject></foreignObject></svg></body></html>',
        "text/html",
    );
    const div = doc.getElementById("a") as HTMLElement;

    it("returns the spec nodeName for every node kind through the prototype getter", () => {
        expect(nodeNameGetter).toBeTypeOf("function");
        expect(readNodeName(doc)).toBe("#document");
        expect(readNodeName(doc.doctype)).toBe("html");
        expect(readNodeName(div)).toBe("DIV");
        expect(readNodeName(div.getAttributeNode("data-x"))).toBe("data-x");
        expect(readNodeName(div.firstChild)).toBe("#text");
        expect(readNodeName(div.lastChild)).toBe("#comment");
        expect(readNodeName(doc.createDocumentFragment())).toBe("#document-fragment");
        expect(readNodeName(doc.createProcessingInstruction("xml-stylesheet", 'href="a.css"'))).toBe("xml-stylesheet");
    });

    it("keeps element casing and reaches template content and shadow roots", () => {
        expect(readNodeName(doc.querySelector("foreignObject"))).toBe("foreignObject");

        const template = doc.createElement("template");
        template.innerHTML = "<span></span>";
        expect(readNodeName(template.content)).toBe("#document-fragment");
        expect(readNodeName(template.content.firstChild)).toBe("SPAN");

        const host = document.createElement("div");
        const shadow = host.attachShadow({ mode: "open" });
        expect(readNodeName(shadow)).toBe("#document-fragment");

        const detached = document.createElement("p");
        expect(readNodeName(detached)).toBe("P");
        expect(readNodeName(detached.cloneNode())).toBe("P");
    });

    it("agrees with direct property access", () => {
        for (const node of [doc, doc.doctype, div, div.firstChild, div.lastChild, doc.body, document]) {
            expect(readNodeName(node)).toBe(node?.nodeName);
        }
    });

    it("rejects a non-node receiver instead of inventing a name", () => {
        expect(() => readNodeName({})).toThrow(TypeError);
    });

    it("serves the other accessors DOMPurify captures from the prototypes", () => {
        const nodeType = lookupGetter(Node.prototype, "nodeType");
        const ownerDocument = lookupGetter(Node.prototype, "ownerDocument");
        const nextSibling = lookupGetter(Element.prototype, "nextSibling");
        const childNodes = lookupGetter(Element.prototype, "childNodes");
        const parentNode = lookupGetter(Element.prototype, "parentNode");
        const attributes = lookupGetter(Element.prototype, "attributes");
        const shadowRoot = lookupGetter(Element.prototype, "shadowRoot");
        const cloneNode = lookupGetter(Element.prototype, "cloneNode");
        const remove = lookupGetter(Element.prototype, "remove");
        const removeAttributeNode = lookupGetter(Element.prototype, "removeAttributeNode");

        const body = doc.body;
        const svg = body.lastChild as Element;
        expect(nodeType?.call(div)).toBe(Node.ELEMENT_NODE);
        expect(nodeType?.call(div.firstChild)).toBe(Node.TEXT_NODE);
        expect(nodeType?.call(doc)).toBe(Node.DOCUMENT_NODE);
        expect(ownerDocument?.call(div)).toBe(doc);
        expect(ownerDocument?.call(doc)).toBeNull();
        expect(nextSibling?.call(div)).toBe(svg);
        expect(nextSibling?.call(svg)).toBeNull();
        expect(parentNode?.call(div)).toBe(body);
        expect(Array.from(childNodes?.call(div) as NodeList).map(readNodeName)).toEqual(["#text", "#comment"]);
        expect(Array.from(attributes?.call(div) as NamedNodeMap).map((a) => a.name)).toEqual(["id", "data-x"]);
        expect(shadowRoot?.call(div)).toBeNull();

        const host = document.createElement("div");
        const shadow = host.attachShadow({ mode: "open" });
        expect(shadowRoot?.call(host)).toBe(shadow);

        const template = doc.createElement("template");
        template.innerHTML = "<i></i><u></u>";
        expect(Array.from(childNodes?.call(template.content) as NodeList).map(readNodeName)).toEqual(["I", "U"]);

        const copy = cloneNode?.call(div, true) as HTMLElement;
        expect(readNodeName(copy)).toBe("DIV");
        expect(copy.getAttribute("data-x")).toBe("1");
        expect(parentNode?.call(copy)).toBeNull();
        removeAttributeNode?.call(copy, copy.getAttributeNode("data-x"));
        expect(copy.hasAttribute("data-x")).toBe(false);

        const child = doc.createElement("em");
        div.appendChild(child);
        remove?.call(child);
        expect(parentNode?.call(child)).toBeNull();
        expect(Array.from(childNodes?.call(div) as NodeList).map(readNodeName)).toEqual(["#text", "#comment"]);

        const created = document.implementation.createHTMLDocument("x");
        created.body.innerHTML = "<a></a>";
        expect(readNodeName(created)).toBe("#document");
        expect(readNodeName(created.body.firstChild)).toBe("A");
        expect(ownerDocument?.call(created.body)).toBe(created);
    });

    it("lets a DOMPurify instance created after setup sanitize under happy-dom", () => {
        const purify = DOMPurify(window);
        const config = { ADD_TAGS: ["risu-style"] };

        expect(
            purify.sanitize(
                '<risu-style>abc</risu-style><b onerror="x()">y</b><img src="x" onerror="alert(1)"><script>1</script>',
                config,
            ),
        ).toBe('<risu-style>abc</risu-style><b>y</b><img src="x">');
        expect(purify.removed).toHaveLength(3);

        const root = purify.sanitize("<risu-style>abc</risu-style><p>z</p>", {
            ...config,
            RETURN_DOM: true,
        }) as HTMLElement;
        expect(root.nodeName).toBe("BODY");
        expect(root.innerHTML).toBe("<risu-style>abc</risu-style><p>z</p>");
    });
});
