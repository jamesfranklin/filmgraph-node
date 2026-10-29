import { describe, expect, it } from "vitest";
import { filmSlug, parseFilmRef, splitSlug } from "../src/slug";

describe("filmSlug", () => {
  it("matches the reference implementation", () => {
    expect(filmSlug("Gods Don't Give Gifts", 2026)).toBe("gods-dont-give-gifts-2026");
    expect(filmSlug("Amélie & Co.", 2001)).toBe("amelie-and-co-2001");
    expect(filmSlug("The End of the Line", 2009, 2)).toBe("the-end-of-the-line-2009-2");
    expect(filmSlug("  Parasite  ", 2019)).toBe("parasite-2019");
  });
  it("rejects suffix 1 and empty titles", () => {
    expect(() => filmSlug("X", 2020, 1)).toThrow();
    expect(() => filmSlug("기생충", 2019)).toThrow(); // no ASCII left: caller must romanise
  });
});

describe("parseFilmRef", () => {
  it("classifies uuid, slug and prefixed external ids", () => {
    expect(parseFilmRef("f0a1b2c3-4d5e-5f60-9a8b-7c6d5e4f3a21")).toEqual({ kind: "uuid", value: "f0a1b2c3-4d5e-5f60-9a8b-7c6d5e4f3a21" });
    expect(parseFilmRef("Parasite-2019")).toEqual({ kind: "slug", value: "parasite-2019" });
    expect(parseFilmRef("tmdb:496243")).toEqual({ kind: "external", system: "tmdb", value: "496243" });
    expect(parseFilmRef("imdb:tt6751668")).toEqual({ kind: "external", system: "imdb", value: "tt6751668" });
  });
  it("treats bare integers as (non-matching) slugs, never tmdb ids", () => {
    expect(parseFilmRef("496243")).toEqual({ kind: "slug", value: "496243" });
  });
});

describe("splitSlug", () => {
  it("strips year and collision suffix", () => {
    expect(splitSlug("the-end-of-the-line-2009-2")).toEqual(["the-end-of-the-line", 2009]);
    expect(splitSlug("parasite-2019")).toEqual(["parasite", 2019]);
    expect(splitSlug("nope")).toBeNull();
  });
});
