import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { splitSql } from "../src/db.js";

const schemaPath = new URL("../migrations/001_initial.sql", import.meta.url);

describe("schema statement splitting", () => {
  it("keeps comment text out of every statement", async () => {
    for (const statement of splitSql(await readFile(schemaPath, "utf8"))) {
      // A statement carrying a stray comment fragment is the failure mode this
      // guards: `--` inside a comment that a `;` had cut in half used to be
      // pasted onto the front of the next `create table`, which then failed at
      // boot with a syntax error a long way from its cause.
      expect(statement).not.toMatch(/--/);
      expect(statement).toMatch(/^(create|insert|update|delete|drop|alter|pragma|with)\b/i);
    }
  });

  it("holds the schema to line-leading comments only", async () => {
    // splitSql strips comments line-wise before splitting, so an inline `--`
    // (or one inside a string literal) would be removed along with the rest of
    // its line. Nothing in the file does that today, and this keeps it so.
    const offenders = (await readFile(schemaPath, "utf8"))
      .split("\n")
      .filter((line) => line.includes("--") && !line.trim().startsWith("--"));
    expect(offenders).toEqual([]);
  });

  it("splits every table and index in the schema into its own statement", async () => {
    const statements = splitSql(await readFile(schemaPath, "utf8"));
    const source = await readFile(schemaPath, "utf8");
    const declared = (source.match(/^create (table|index|unique index)/gim) ?? []).length;
    const split = statements.filter((statement) => /^create /i.test(statement)).length;
    expect(split).toBe(declared);
  });
});
