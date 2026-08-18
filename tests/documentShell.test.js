import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const documentShell = await readFile(new URL("../index.html", import.meta.url), "utf8");

describe("document shell", () => {
  it("uses Mario Ciavarella's favicon and permits only its origin for that external image", () => {
    expect(documentShell).toContain('href="https://mariociavarella.com/mario-favicon.png?v=3"');
    expect(documentShell).toContain("img-src 'self' data: https://mariociavarella.com https://www.mariociavarella.com;");
  });
});
