// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// Screenshots one element of a live page in every theme and width of the QA matrix.
//
//   node scripts/workflow-qa/cli.ts shot --url <url> --selector <css> --surface <name> --state <name>
//     --out <dir> [--storage-state <pw-state.json>] [--repo <checkout>] [--timeout <ms>]
//
// A selector that matches no element, or more than one, fails the run and takes no screenshot, so a
// frame can never be saved of the wrong thing. The page is observed, never driven: state shown in
// a frame is whatever the live app reports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  WORKFLOW_QA_THEMES,
  WORKFLOW_QA_VIEWPORTS,
  workflowQaFrameName,
  type WorkflowQaFrame,
} from "@t3tools/shared/testing/workflowQa";

import { coverageFields, findProblems, repoFingerprint, writeManifest } from "./manifest.ts";
import { launchBrowser } from "./playwright.ts";
import { isEmptyOrMissing } from "./util.ts";

// The key apps/web/src/themePalette.ts reads the appearance mode from (THEME_APPEARANCE_MODE_STORAGE_KEY).
const APPEARANCE_STORAGE_KEY = "t3code:theme-appearance-mode";

export interface ShotOptions {
  /** The checkout being served; its code is what the frames show. */
  readonly repo: string;
  /** The checkout whose scripts take the shots, recorded beside `repo`. */
  readonly toolRepo: string;
  readonly url: string;
  readonly selector: string;
  readonly surface: string;
  readonly state: string;
  readonly out: string;
  readonly storageState: string | undefined;
  readonly timeoutMs: number;
  /** A system browser such as `msedge`, when the bundled Chromium is not installed. */
  readonly channel: string | undefined;
}

export async function runShot(options: ShotOptions): Promise<number> {
  const out = NodePath.resolve(options.out);
  if (!isEmptyOrMissing(out)) {
    console.error(`shot: ${out} already holds files; choose a new --out.`);
    return 2;
  }
  NodeFS.mkdirSync(out, { recursive: true });
  const browser = await launchBrowser(options.repo, options.channel);
  const frames: Array<WorkflowQaFrame> = [];
  const problems: Array<string> = [];
  try {
    for (const theme of WORKFLOW_QA_THEMES) {
      for (const viewport of WORKFLOW_QA_VIEWPORTS) {
        const base = {
          surface: options.surface,
          state: options.state,
          theme,
          width: viewport.width,
        };
        const name = workflowQaFrameName(base);
        const context = await browser.newContext({
          ...(options.storageState === undefined ? {} : { storageState: options.storageState }),
          viewport,
          colorScheme: theme,
        });
        try {
          await context.addInitScript(
            `window.localStorage.setItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)}, ${JSON.stringify(theme)});`,
          );
          const page = await context.newPage();
          await page.goto(options.url, {
            waitUntil: "domcontentloaded",
            timeout: options.timeoutMs,
          });
          const target = page.locator(options.selector);
          // A selector that never appears is an answer, not an error to retry past.
          await target
            .first()
            .waitFor({ state: "visible", timeout: options.timeoutMs })
            .catch(() => {});
          const matchCount = await target.count();
          if (matchCount !== 1) {
            problems.push(
              `${name}: selector "${options.selector}" matched ${matchCount} elements, expected exactly one. No screenshot taken.`,
            );
            continue;
          }
          const file = `${name}.png`;
          await target.screenshot({ path: NodePath.join(out, file) });
          const box = (await target.boundingBox()) ?? { width: 0, height: 0 };
          const facts = await page.evaluate<{
            dark: boolean;
            innerWidth: number;
            overflowX: boolean;
          }>(`({
            dark: document.documentElement.classList.contains("dark"),
            innerWidth: window.innerWidth,
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          })`);
          const frame: WorkflowQaFrame = {
            ...base,
            height: viewport.height,
            selector: options.selector,
            matchCount,
            frameSelector: options.selector,
            file,
            box: { width: Math.round(box.width), height: Math.round(box.height) },
            htmlDark: facts.dark,
            innerWidth: facts.innerWidth,
            pageOverflowX: facts.overflowX,
          };
          frames.push(frame);
          NodeFS.writeFileSync(
            NodePath.join(out, `${name}.json`),
            `${JSON.stringify(frame, null, 2)}\n`,
          );
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  // Frames that never happened are already problems; the rest are checked like fixture frames.
  const verified = findProblems(frames, out)
    .filter((problem) => problem.kind !== "missing")
    .map((problem) => problem.message);
  const all = [...problems, ...verified];
  writeManifest(out, {
    kind: "live",
    createdAt: new Date().toISOString(),
    repo: repoFingerprint(options.repo),
    tool: repoFingerprint(options.toolRepo),
    command: `shot ${options.url} ${options.selector}`,
    frames,
    problems: all,
    ...coverageFields(frames, false),
  });
  console.log(
    `shot: ${frames.length} frames, ${all.length} problems. Manifest: ${NodePath.join(out, "manifest.md")}`,
  );
  for (const problem of all.slice(0, 20)) console.error(`  ${problem}`);
  return all.length === 0 &&
    frames.length === WORKFLOW_QA_THEMES.length * WORKFLOW_QA_VIEWPORTS.length
    ? 0
    : 1;
}
