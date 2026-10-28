// @effect-diagnostics nodeBuiltinImport:off - the tests build a real temporary git repository.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { scanChangedEncoding, scanEncoding } from "./encoding.ts";
import { git } from "./util.ts";

// "—" and "é" read back as Windows-1252, the damage a Windows shell does to UTF-8 source.
const damagedDash = "\u00e2\u20ac\u201d";
const damagedAccent = "\u00c3\u00a9";

it("scans changed non-ASCII paths with Git path quoting enabled", () => {
  using directory = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "workflow-qa-encoding-"),
  );
  const cwd = directory.path;
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "test"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "core.quotePath", "true"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
  const path = "caf\u00e9.md";
  NodeFS.writeFileSync(NodePath.join(cwd, path), "Original text\n");
  git(cwd, ["add", "--", path]);
  git(cwd, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  NodeFS.writeFileSync(NodePath.join(cwd, path), `Original text\nBroken ${damagedDash}\n`);
  expect(scanChangedEncoding(cwd, "HEAD")).toEqual([`${path}:2: Broken ${damagedDash}`]);
});

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
