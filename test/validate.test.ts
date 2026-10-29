import { describe, expect, it } from "vitest";
import { validateNode } from "../scripts/validate";

describe("validateNode", () => {
  const film = { id: "7d2b1c3e-5a4f-5b6c-8d9e-0f1a2b3c4d5e", slug: "x-2020", title: "X", year: 2020 };
  it("accepts a minimal v1.1 Film", () => expect(validateNode("Film", film)).toEqual([]));
  it("requires slug", () => expect(validateNode("Film", { ...film, slug: undefined })).toContain("(root): 'slug' is a required property"));
  it("rejects a bad slug", () => expect(validateNode("Film", { ...film, slug: "X 2020" })[0]).toMatch(/does not match/));
  it("rejects unknown properties", () => expect(validateNode("Film", { ...film, rating: 5 })[0]).toMatch(/additional property/));
  it("allows null title_en", () => expect(validateNode("Film", { ...film, title_en: null })).toEqual([]));
  it("checks nested external_ids", () =>
    expect(validateNode("Film", { ...film, external_ids: { imdb: "6751668" } })[0]).toMatch(/external_ids.imdb/));
});
