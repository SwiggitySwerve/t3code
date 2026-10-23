/**
 * How a T3-run workflow's script is stored on its row: an optional settings line
 * (args and token budget) above the script source. The server writes and resumes
 * from it; clients show the source.
 */
const SETTINGS_HEADER = "// t3-workflow: ";

export interface StoredWorkflowSettings {
  readonly args?: unknown;
  readonly budgetTokens?: number;
  /** The reviewed graph's plan, for workflows started from one; the reader decodes it. */
  readonly plan?: unknown;
}

/** Always writes the settings line, so a script that itself starts with it is not misread. */
export function storedWorkflowScript(source: string, settings: StoredWorkflowSettings): string {
  return `${SETTINGS_HEADER}${JSON.stringify(settings)}\n${source}`;
}

/** The script source alone, without reading the settings. */
export function storedWorkflowScriptSource(stored: string): string {
  if (!stored.startsWith(SETTINGS_HEADER)) return stored;
  const newline = stored.indexOf("\n");
  return newline === -1 ? "" : stored.slice(newline + 1);
}

/** Throws when the settings line is not valid JSON. */
export function parseStoredWorkflowScript(stored: string): {
  readonly source: string;
  readonly args: unknown;
  readonly budgetTokens: number | undefined;
  readonly plan: unknown;
} {
  const source = storedWorkflowScriptSource(stored);
  if (!stored.startsWith(SETTINGS_HEADER)) {
    return { source, args: null, budgetTokens: undefined, plan: undefined };
  }
  const newline = stored.indexOf("\n");
  const parsed: unknown = JSON.parse(stored.slice(SETTINGS_HEADER.length, newline));
  const settings =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  return {
    source,
    args: settings.args ?? null,
    budgetTokens: typeof settings.budgetTokens === "number" ? settings.budgetTokens : undefined,
    plan: settings.plan,
  };
}
