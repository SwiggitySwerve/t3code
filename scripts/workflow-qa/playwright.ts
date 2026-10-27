// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// The slice of Playwright the QA commands use. The package belongs to apps/web, so it is resolved
// from there at run time rather than declared as a dependency of the scripts.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { WorkflowQaTheme } from "@t3tools/shared/testing/workflowQa";

export interface Locator {
  count(): Promise<number>;
  first(): Locator;
  waitFor(options: { state: "visible"; timeout: number }): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  boundingBox(): Promise<{ width: number; height: number } | null>;
}

export interface Page {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForURL(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
  locator(selector: string): Locator;
  /** Runs a JavaScript expression in the page; a string, because the scripts have no DOM types. */
  evaluate<T>(expression: string): Promise<T>;
}

export interface BrowserContext {
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<Page>;
  storageState(options: { path: string }): Promise<unknown>;
  close(): Promise<void>;
}

export interface Browser {
  newContext(options: {
    storageState?: string;
    viewport?: { width: number; height: number };
    colorScheme?: WorkflowQaTheme;
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface Playwright {
  chromium: { launch(options: { headless: true; channel?: string }): Promise<Browser> };
}

export function launchBrowser(repo: string, channel: string | undefined): Promise<Browser> {
  const require = NodeModule.createRequire(NodePath.join(repo, "apps", "web", "package.json"));
  const { chromium } = require("playwright") as Playwright;
  return chromium.launch({ headless: true, ...(channel === undefined ? {} : { channel }) });
}
