// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const sharedDir = path.resolve(import.meta.dirname, "../../../shared");

// Vitest resolves imports through Vite, which tolerates a missing `.ts` extension; the server runs
// `shared/` through plain Node type stripping, which does not. Only a real `node` proves the folder
// loads at runtime. (Type-only imports are erased before Node resolves them; the `nodenext` server
// `tsc` in `pnpm check` guards their extensions.)
it("imports every shared/**/*.ts with plain node", () => {
    const files = readdirSync(sharedDir, { recursive: true, encoding: "utf8" })
        .map((name) => name.split(path.sep).join("/"))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .sort();
    expect(files).toContain("database.ts");
    // The server runtime modules live in subfolders.
    expect(files).toContain("cbs/evaluator.ts");
    expect(files).toContain("scripts/regex.ts");
    const script = files
        .map((name) => `await import(${JSON.stringify(pathToFileURL(path.join(sharedDir, name)).href)});`)
        .join("\n");
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `${script}\nconsole.log("ok");`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output.trim()).toBe("ok");
});
