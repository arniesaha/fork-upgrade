import { describe, expect, it } from "vitest";
import { filterAndOrderTags } from "../../src/ladder.js";

const PRE = "-(rc|alpha|beta|pre)";

describe("filterAndOrderTags", () => {
  it("returns intermediate+target tags in (base, target], excluding intermediate pre-releases", () => {
    const tags = ["v1", "v2", "v2.1-rc", "v3"];
    expect(filterAndOrderTags(tags, { base: "v1", target: "v3", prereleasePattern: PRE })).toEqual(["v2", "v3"]);
  });

  it("keeps an explicitly-targeted pre-release even though it matches the pattern", () => {
    const tags = ["v1", "v2", "v3.0-rc"];
    expect(filterAndOrderTags(tags, { base: "v1", target: "v3.0-rc", prereleasePattern: PRE })).toEqual(["v2", "v3.0-rc"]);
  });

  it("returns a single-element ladder for an adjacent target", () => {
    const tags = ["v1", "v2"];
    expect(filterAndOrderTags(tags, { base: "v1", target: "v2", prereleasePattern: PRE })).toEqual(["v2"]);
  });

  it("throws when the target is not ahead of the base", () => {
    const tags = ["v1", "v2"];
    expect(() => filterAndOrderTags(tags, { base: "v2", target: "v1", prereleasePattern: PRE })).toThrow(/not ahead/);
  });

  it("throws when the target tag is unknown", () => {
    const tags = ["v1", "v2"];
    expect(() => filterAndOrderTags(tags, { base: "v1", target: "v9", prereleasePattern: PRE })).toThrow(/not found/);
  });
});
