// The helpers of `src/ts/util.ts` the request layer uses, copied for the server.

/** `sleep`; with a signal it also ends early when the signal aborts (it never rejects). */
export function sleep(ms: number, signal?: AbortSignal | null) {
    return new Promise<void>((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
    });
}

export async function replaceAsync(
    string: string,
    regexp: RegExp,
    replacerFunction: (...args: string[]) => Promise<string>,
) {
    const replacements = await Promise.all(
        Array.from(string.matchAll(regexp), (match) => replacerFunction(...(match as string[]))),
    );
    let i = 0;
    return string.replace(regexp, () => replacements[i++]);
}

export function simplifySchema(
    schema: any,
    args: {
        upperType?: boolean;
    } = {},
) {
    if (!schema || typeof schema !== "object") {
        return schema;
    }

    if (Array.isArray(schema.type)) {
        if (schema.type.includes("null")) {
            schema.nullable = true;
        }
        schema.type = (schema.type as string[]).filter((v) => v !== "null")[0];
    }

    const result: any = {};

    if (schema.type) {
        result.type = (schema.type as string)?.toLowerCase();
    }
    if (schema.type === "object") {
        result.properties = {};
        for (const key in schema.properties) {
            result.properties[key] = simplifySchema(schema.properties[key], args);
        }
        if (schema.required && schema.required.length > 0) {
            result.required = schema.required;
        }
    }
    if (schema.type === "array") {
        result.items = simplifySchema(schema.items, args);
    }

    if (schema.type === "string" && schema.enum && schema.enum.length > 0) {
        result.enum = schema.enum;
    }

    if (schema.type === "string" && schema.format) {
        result.format = schema.format;
    }

    if (schema.nullable) {
        result.nullable = true;
    }

    if (schema.maxLength !== undefined && schema.maxLength !== null) {
        result.maxLength = schema.maxLength;
    }

    if (schema.minLength !== undefined && schema.minLength !== null) {
        result.minLength = schema.minLength;
    }

    if (schema.minProperties !== undefined && schema.minProperties !== null) {
        result.minProperties = schema.minProperties;
    }

    if (schema.maxProperties !== undefined && schema.maxProperties !== null) {
        result.maxProperties = schema.maxProperties;
    }

    if (schema.description) {
        result.description = schema.description;
    }

    if (schema.anyOf && schema.anyOf.length > 0) {
        result.anyOf = schema.anyOf.map((v: any) => simplifySchema(v, args));
    }

    return result;
}

export function base64url(source: Uint8Array | ArrayBuffer): string {
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
    let encodedSource = btoa(String.fromCharCode.apply(null, [...bytes]))
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    return encodedSource;
}

export const jsonOutputTrimmer = (data: string) => {
    data = data.replace(/<Thoughts>(.+?)<\/Thoughts>/gms, "").trim();
    if (data.startsWith("```json") && data.endsWith("```")) {
        data = data.slice(7, -3).trim();
    }
    return data.trim();
};
