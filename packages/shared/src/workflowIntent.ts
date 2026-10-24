/**
 * Whether a person's message asks for a workflow: the one detector the server (to arm graph
 * planning) and the composer (to show the chip) share, so they cannot disagree.
 *
 * It matches the built-in word "workflow" and the user's extra words or phrases as literal,
 * case-insensitive whole words in person-typed text. Composer context chips are stripped
 * first, using their owning parser. Whether the sender or thread may trigger anything is
 * decided by the caller, not here.
 *
 * Each occurrence is judged on its own, so an excluded one never hides a valid one elsewhere:
 * - code: inline code spans and fenced blocks;
 * - URLs, paths, file names and identifiers (`workflow_start`, `.github/workflows/ci.yml`):
 *   a match must be the whole whitespace-delimited token, apart from quotes, brackets and
 *   sentence punctuation;
 * - CI compounds: "CI", "GitHub Actions", "pipeline", "build", "release" or "deploy"
 *   workflow, and workflow "file", "yaml", "yml" or "dispatch".
 *
 * Phrases are compared token by token, never compiled into a pattern, so a custom phrase
 * cannot inject pattern syntax.
 */
import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";
import { replaceComposerContextReferences } from "./composerContextReferences.ts";

/** Always matched while triggers are on; it cannot be removed. */
const BUILT_IN_WORKFLOW_TRIGGER = "workflow";
/** A phrase is a word or short phrase, not a sentence; the settings write boundary enforces it. */
export const WORKFLOW_TRIGGER_PHRASE_MAX_CHARS = 64;

export interface WorkflowTriggerSettings {
  readonly enabled: boolean;
  readonly extras: ReadonlyArray<string>;
}

export interface WorkflowIntent {
  /** The configured word or phrase that matched, as written in the settings. */
  readonly keyword: string;
}

const DEFAULT_TRIGGERS: WorkflowTriggerSettings = { enabled: true, extras: [] };

// Dashes separate words in prose ("workflow—now"); a hyphen inside a word does not.
const TOKEN = /[^\s\u2013\u2014]+/gu;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
// Characters that may hug a word without making it part of a path, URL or identifier.
const OPENING_GLUE = "(\"'\u201C\u2018[{*~";
const CLOSING_GLUE = ")\"'\u201D\u2019]}*~";
const SENTENCE_PUNCTUATION = ",.;:!?\u2026";
const POSSESSIVE = /^['\u2019]s/;

const COMPOUND_BEFORE = new Set([
  "ci",
  "cd",
  "ci/cd",
  "cicd",
  "pipeline",
  "build",
  "release",
  "deploy",
  "deployment",
]);
const COMPOUND_AFTER = new Set(["file", "files", "yaml", "yml", "dispatch"]);

/** One phrase's comparison form; the owner of "same phrase" for matching and for validation. */
export function normalizeWorkflowTriggerPhrase(phrase: string): string {
  return phrase.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * What is wrong with a list of extra words or phrases, in order; empty when it can be saved.
 * The built-in word is always on, so repeating it is a duplicate.
 */
export function workflowTriggerExtrasProblems(
  extras: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const seen = new Set([BUILT_IN_WORKFLOW_TRIGGER]);
  for (const extra of extras) {
    const phrase = normalizeWorkflowTriggerPhrase(extra);
    if (phrase.length === 0) {
      problems.push("A trigger word or phrase cannot be empty.");
    } else if (Array.from(phrase).length > WORKFLOW_TRIGGER_PHRASE_MAX_CHARS) {
      problems.push(
        `"${extra.trim().slice(0, 24)}\u2026" is longer than ${WORKFLOW_TRIGGER_PHRASE_MAX_CHARS} characters.`,
      );
    } else if (seen.has(phrase)) {
      problems.push(
        phrase === BUILT_IN_WORKFLOW_TRIGGER
          ? `"${BUILT_IN_WORKFLOW_TRIGGER}" is always a trigger.`
          : `"${extra.trim()}" is listed twice.`,
      );
    } else {
      seen.add(phrase);
    }
  }
  return problems;
}

/** The text a person typed: context chips and the legacy context blocks removed. */
function typedText(text: string): string {
  return replaceComposerContextReferences(upgradeLegacyContextMessage(text).text, () => " ");
}

const blank = (text: string) => text.replace(/[^\n]/gu, " ");

function closesFence(line: string, fence: { readonly char: string; readonly length: number }) {
  const trimmed = line.replace(/^ {0,3}/u, "");
  let run = 0;
  while (trimmed[run] === fence.char) run += 1;
  return run >= fence.length && trimmed.slice(run).trim() === "";
}

function maskInlineCode(line: string): string {
  let result = "";
  let cursor = 0;
  let index = line.indexOf("`");
  while (index !== -1) {
    let length = 1;
    while (line[index + length] === "`") length += 1;
    // A backtick run closes only at a run of the same length; an unmatched run is literal.
    let close = line.indexOf("`", index + length);
    while (close !== -1) {
      let closeLength = 1;
      while (line[close + closeLength] === "`") closeLength += 1;
      if (closeLength === length) break;
      close = line.indexOf("`", close + closeLength);
    }
    if (close === -1) {
      index = line.indexOf("`", index + length);
      continue;
    }
    result += line.slice(cursor, index) + " ".repeat(close + length - index);
    cursor = close + length;
    index = line.indexOf("`", cursor);
  }
  return result + line.slice(cursor);
}

/** Same length as the input, with code replaced by spaces so token boundaries stay put. */
function maskCode(text: string): string {
  let fence: { readonly char: string; readonly length: number } | null = null;
  return text
    .split("\n")
    .map((line) => {
      if (fence !== null) {
        if (closesFence(line, fence)) fence = null;
        return blank(line);
      }
      const opening = FENCE_OPEN.exec(line);
      // A backtick fence's info string cannot hold a backtick: "```x```" is inline code.
      if (
        opening !== null &&
        !(opening[1]![0] === "`" && line.slice(opening[0].length).includes("`"))
      ) {
        fence = { char: opening[1]![0]!, length: opening[1]!.length };
        return blank(line);
      }
      return maskInlineCode(line);
    })
    .join("\n");
}

const consistsOf = (text: string, allowed: string) => {
  for (const char of text) if (!allowed.includes(char)) return false;
  return true;
};
const isOpeningGlue = (text: string) => consistsOf(text, OPENING_GLUE);
const isClosingGlue = (text: string) =>
  consistsOf(POSSESSIVE.test(text) ? text.slice(2) : text, CLOSING_GLUE + SENTENCE_PUNCTUATION);

/** The token as a bare word, for compound checks: quotes and brackets off, sentence marks kept. */
function bareWord(token: string, trailing: "keep" | "drop"): string {
  let start = 0;
  let end = token.length;
  while (start < end && OPENING_GLUE.includes(token[start]!)) start += 1;
  const closing = trailing === "drop" ? CLOSING_GLUE + SENTENCE_PUNCTUATION : CLOSING_GLUE;
  while (end > start && closing.includes(token[end - 1]!)) end -= 1;
  return token.slice(start, end);
}

/** Whether the words starting at `index` are exactly `words`, with only glue around them. */
function phraseAt(tokens: ReadonlyArray<string>, index: number, words: ReadonlyArray<string>) {
  const last = words.length - 1;
  for (let offset = 0; offset <= last; offset += 1) {
    const token = tokens[index + offset];
    const word = words[offset]!;
    if (token === undefined) return false;
    if (last === 0) {
      for (let at = token.indexOf(word); at !== -1; at = token.indexOf(word, at + 1)) {
        if (isOpeningGlue(token.slice(0, at)) && isClosingGlue(token.slice(at + word.length))) {
          return true;
        }
      }
      return false;
    }
    if (offset === 0) {
      if (!token.endsWith(word) || !isOpeningGlue(token.slice(0, token.length - word.length))) {
        return false;
      }
    } else if (offset === last) {
      if (!token.startsWith(word) || !isClosingGlue(token.slice(word.length))) return false;
    } else if (token !== word) {
      return false;
    }
  }
  return true;
}

function isCiCompound(tokens: ReadonlyArray<string>, index: number, length: number): boolean {
  const before = tokens[index - 1];
  const after = tokens[index + length];
  if (after !== undefined && COMPOUND_AFTER.has(bareWord(after, "drop"))) return true;
  if (before === undefined) return false;
  const previous = bareWord(before, "keep");
  if (COMPOUND_BEFORE.has(previous)) return true;
  const beforeThat = tokens[index - 2];
  return (
    previous === "actions" && beforeThat !== undefined && bareWord(beforeThat, "keep") === "github"
  );
}

/**
 * The first valid trigger in a person's message, or null. `triggers` defaults to the built-in
 * word alone; `enabled: false` returns null for every word, the built-in one included.
 */
export function detectWorkflowIntent(
  text: string,
  triggers: WorkflowTriggerSettings = DEFAULT_TRIGGERS,
): WorkflowIntent | null {
  if (!triggers.enabled) return null;
  const phrases = [BUILT_IN_WORKFLOW_TRIGGER, ...triggers.extras].flatMap((keyword) => {
    const words = normalizeWorkflowTriggerPhrase(keyword).split(" ");
    return words[0] === "" ? [] : [{ keyword: keyword.trim(), words }];
  });
  const tokens = Array.from(maskCode(typedText(text)).matchAll(TOKEN), (match) =>
    match[0].toLowerCase(),
  );
  for (let index = 0; index < tokens.length; index += 1) {
    for (const { keyword, words } of phrases) {
      if (phraseAt(tokens, index, words) && !isCiCompound(tokens, index, words.length)) {
        return { keyword };
      }
    }
  }
  return null;
}
