import { expect, it } from "vite-plus/test";

import { scanEncoding } from "./encoding.ts";

// "—" and "é" read back as Windows-1252, the damage a Windows shell does to UTF-8 source.
const damagedDash = "\u00e2\u20ac\u201d";
const damagedAccent = "\u00c3\u00a9";

it("reports damaged lines a change adds and not damage already at the base", () => {
  expect(
    scanEncoding([
      {
        path: "a.ts",
        before: `const old = "caf${damagedAccent}";\nconst fine = 1;`,
        now: `const old = "caf${damagedAccent}";\nconst fresh = "a ${damagedDash} b";\nconst fine = 1;`,
      },
    ]),
  ).toEqual([`a.ts:2: const fresh = "a ${damagedDash} b";`]);
});

it("accepts correctly encoded text, including real dashes and accents", () => {
  expect(
    scanEncoding([{ path: "b.md", before: null, now: "A real em dash \u2014 and caf\u00e9." }]),
  ).toEqual([]);
});

it("reports a byte order mark a change adds, but not one the file already had", () => {
  expect(scanEncoding([{ path: "c.json", before: "{}", now: "\uFEFF{}" }])).toEqual([
    "c.json:1: byte order mark added",
  ]);
  expect(scanEncoding([{ path: "d.json", before: "\uFEFF{}", now: "\uFEFF{ }" }])).toEqual([]);
});
