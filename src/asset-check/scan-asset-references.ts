import {
  type Token,
  Tokenizer,
  TokenizerMode,
} from "parse5";

type TagToken = Token.TagToken;

/** Where a reference was written, which decides how a browser loads it. */
export type ScannedReferenceKind =
  | "css-import"
  | "css-url"
  | "html-attr"
  | "meta-refresh"
  | "script";

/** One URL-like value exactly as an author wrote it, before resolution. */
export interface ScannedReference {
  readonly kind: ScannedReferenceKind;
  readonly line: number;
  /** A document navigation, which a single-page application may answer with its entry. */
  readonly navigation: boolean;
  readonly raw: string;
}

/** The references of one HTML document and the `<base href>` they resolve against. */
export interface ScannedHtmlDocument {
  readonly baseHref: string | null;
  readonly references: readonly ScannedReference[];
}

/** Text inside a `<style>` or `<script>` element, collected until its end tag. */
interface InlineText {
  readonly language: "css" | "script" | null;
  line: number | null;
  readonly tagName: string;
  text: string;
}

/** A value read from source text and the offset just past it. */
interface LexedValue {
  readonly end: number;
  readonly value: string;
}

// The tree builder switches the tokenizer into these modes; scanning without
// a tree has to do the same, or element text would be read as markup.
const textModes: ReadonlyMap<string, (typeof TokenizerMode)[keyof typeof TokenizerMode]> = new Map([
  ["iframe", TokenizerMode.RAWTEXT],
  ["noembed", TokenizerMode.RAWTEXT],
  ["noframes", TokenizerMode.RAWTEXT],
  ["noscript", TokenizerMode.RAWTEXT],
  ["plaintext", TokenizerMode.PLAINTEXT],
  ["script", TokenizerMode.SCRIPT_DATA],
  ["style", TokenizerMode.RAWTEXT],
  ["textarea", TokenizerMode.RCDATA],
  ["title", TokenizerMode.RCDATA],
  ["xmp", TokenizerMode.RAWTEXT],
]);
const srcsetAttributes = new Set(["data-srcset", "srcset"]);
const navigationElements = new Set(["a", "area"]);
const hrefElements = new Set(["a", "area", "link"]);
const scriptTypes = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "module",
  "text/ecmascript",
  "text/javascript",
]);
const assetLiteralPattern =
  /^(?:\.{1,2}\/)*[\w@~%.-]+(?:\/[\w@~%.-]+)*\.(?:avif|css|csv|gif|html|ico|jpe?g|js|json|mjs|mp4|pdf|png|svg|ttf|webm|webp|woff2?)(?:[?#]\S*)?$/iu;
const maximumScriptLiteralLength = 512;

/**
 * Collect every file reference an HTML document makes, inline styles and
 * scripts included. It reads tokens rather than building a tree, so work
 * stays linear however deeply the markup nests.
 */
export function scanHtml(text: string): ScannedHtmlDocument {
  const references: ScannedReference[] = [];
  let baseHref: string | null = null;
  let templateDepth = 0;
  let inline: InlineText | null = null;

  const collect = (token: Token.CharacterToken): void => {
    if (inline === null) return;
    inline.line ??= token.location?.startLine ?? 1;
    inline.text += token.chars;
  };
  const tokenizer: Tokenizer = new Tokenizer({sourceCodeLocationInfo: true}, {
    onCharacter: collect,
    onComment: () => undefined,
    onDoctype: () => undefined,
    onEndTag: (token) => {
      if (token.tagName === "template") templateDepth = Math.max(0, templateDepth - 1);
      if (inline === null || token.tagName !== inline.tagName) return;
      const firstLine = inline.line ?? token.location?.startLine ?? 1;
      if (inline.language === "css") references.push(...scanCss(inline.text, firstLine));
      if (inline.language === "script") references.push(...scanScript(inline.text, firstLine));
      inline = null;
    },
    onEof: () => undefined,
    onNullCharacter: collect,
    onStartTag: (token) => {
      if (token.tagName === "template" && !token.selfClosing) templateDepth += 1;
      if (token.tagName === "base" && baseHref === null && templateDepth === 0) {
        baseHref = attribute(token, "href");
      }
      scanTagAttributes(token, references);
      const mode = textModes.get(token.tagName);
      if (mode === undefined) return;
      tokenizer.state = mode;
      inline = {
        language: token.tagName === "style"
          ? "css"
          : token.tagName === "script" && isClassicOrModuleScript(token)
          ? "script"
          : null,
        line: null,
        tagName: token.tagName,
        text: "",
      };
    },
    onWhitespaceCharacter: collect,
  });
  tokenizer.write(text, true);
  return {baseHref, references};
}

function scanTagAttributes(tag: TagToken, references: ScannedReference[]): void {
  for (const {name, value} of tag.attrs) {
    const line = tag.location?.attrs?.[name]?.startLine ?? tag.location?.startLine ?? 1;
    const add = (raw: string, navigation = false): void => {
      references.push({kind: "html-attr", line, navigation, raw});
    };
    if (name === "src" || name === "poster" || name === "data-src") {
      add(value);
    } else if (srcsetAttributes.has(name)) {
      for (const candidate of srcsetUrls(value)) add(candidate);
    } else if (name === "href" && hrefElements.has(tag.tagName)) {
      add(value, navigationElements.has(tag.tagName));
    } else if (name === "data" && tag.tagName === "object") {
      add(value);
    } else if (name === "style") {
      references.push(...scanCss(value, line));
    }
  }
  if (
    tag.tagName === "meta" &&
    attribute(tag, "http-equiv")?.trim().toLowerCase() === "refresh"
  ) {
    const target = refreshUrl(attribute(tag, "content") ?? "");
    if (target !== null) {
      references.push({
        kind: "meta-refresh",
        line: tag.location?.startLine ?? 1,
        navigation: true,
        raw: target,
      });
    }
  }
}

/** Collect `url(...)` and `@import` references from a stylesheet in one linear pass. */
export function scanCss(text: string, firstLine = 1): readonly ScannedReference[] {
  const references: ScannedReference[] = [];
  const lines = lineIndex(text, firstLine);
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (character === "\"" || character === "'") {
      index = readQuoted(text, index).end;
    } else if (character === "@" && matchesAt(text, index, "@import")) {
      let cursor = skipWhitespace(text, index + "@import".length);
      const start = cursor;
      let raw: string | null = null;
      if (text[cursor] === "\"" || text[cursor] === "'") {
        const quoted = readQuoted(text, cursor);
        raw = unescapeCss(quoted.value);
        cursor = quoted.end;
      } else if (matchesAt(text, cursor, "url(")) {
        const url = readUrlFunction(text, cursor);
        raw = url.value;
        cursor = url.end;
      }
      if (raw !== null) {
        references.push({kind: "css-import", line: lines(start), navigation: false, raw});
      }
      index = Math.max(cursor, index + 1);
    } else if (
      (character === "u" || character === "U") &&
      matchesAt(text, index, "url(") &&
      !isIdentifierCharacter(text[index - 1])
    ) {
      const url = readUrlFunction(text, index);
      references.push({kind: "css-url", line: lines(index), navigation: false, raw: url.value});
      index = url.end;
    } else {
      index += 1;
    }
  }
  return references;
}

/**
 * Collect quoted string literals that look like relative asset paths. A lexer
 * this small cannot tell a regular expression from a division, so the results
 * are heuristic by contract.
 */
export function scanScript(text: string, firstLine = 1): readonly ScannedReference[] {
  const references: ScannedReference[] = [];
  const lines = lineIndex(text, firstLine);
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index + 2);
      index = end === -1 ? text.length : end + 1;
    } else if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (character === "\"" || character === "'" || character === "`") {
      const literal = readQuoted(text, index);
      const value = unescapeScript(literal.value);
      if (
        value.length <= maximumScriptLiteralLength &&
        !(character === "`" && literal.value.includes("${")) &&
        assetLiteralPattern.test(value)
      ) {
        references.push({kind: "script", line: lines(index), navigation: false, raw: value});
      }
      index = literal.end;
    } else {
      index += 1;
    }
  }
  return references;
}

function srcsetUrls(value: string): readonly string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === "," || isWhitespace(value[index]))) {
      index += 1;
    }
    const start = index;
    while (index < value.length && !isWhitespace(value[index])) index += 1;
    let end = index;
    while (end > start && value[end - 1] === ",") end -= 1;
    if (end === index) {
      const descriptorEnd = value.indexOf(",", index);
      index = descriptorEnd === -1 ? value.length : descriptorEnd + 1;
    }
    if (end > start) urls.push(value.slice(start, end));
  }
  return urls;
}

/** A refresh with no leading time is ignored by browsers, so it yields nothing. */
function refreshUrl(content: string): string | null {
  const match = /^\s*[\d.]+\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/isu.exec(content);
  let target = match?.[1]?.trim() ?? "";
  const quote = target[0];
  if (quote === "\"" || quote === "'") {
    const end = target.indexOf(quote, 1);
    target = target.slice(1, end === -1 ? undefined : end);
  }
  return target === "" ? null : target;
}

function readUrlFunction(text: string, start: number): LexedValue {
  const index = skipWhitespace(text, start + "url(".length);
  if (text[index] === "\"" || text[index] === "'") {
    const quoted = readQuoted(text, index);
    const close = text.indexOf(")", quoted.end);
    return {end: close === -1 ? text.length : close + 1, value: unescapeCss(quoted.value)};
  }
  let end = index;
  while (end < text.length && text[end] !== ")") end += text[end] === "\\" ? 2 : 1;
  return {
    end: Math.min(end + 1, text.length),
    value: unescapeCss(text.slice(index, Math.min(end, text.length)).trim()),
  };
}

/**
 * Read a quoted literal from its opening quote, escapes left in place. An
 * unterminated one ends at the line break, or at the end for a template.
 */
function readQuoted(text: string, start: number): LexedValue {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === quote) return {end: index + 1, value: text.slice(start + 1, index)};
    if (character === "\n" && quote !== "`") return {end: index, value: text.slice(start + 1, index)};
    index += character === "\\" ? 2 : 1;
  }
  return {end: text.length, value: text.slice(start + 1)};
}

function unescapeCss(value: string): string {
  return value.replaceAll(
    /\\(?:([\da-f]{1,6})\s?|(\n)|(.))/giu,
    (_: string, hex: string | undefined, _newline: string | undefined, other: string | undefined) =>
      hex === undefined ? (other ?? "") : codePointText(hex, true),
  );
}

function unescapeScript(value: string): string {
  return value.replaceAll(
    /\\(?:u\{([\da-f]{1,6})\}|u([\da-f]{4})|x([\da-f]{2})|(.))/giu,
    (
      _: string,
      braced: string | undefined,
      unicode: string | undefined,
      hex: string | undefined,
      other: string | undefined,
    ) => {
      const code = braced ?? unicode ?? hex;
      return code === undefined ? (other ?? "") : codePointText(code, false);
    },
  );
}

function codePointText(hex: string, zeroIsInvalid: boolean): string {
  const codePoint = Number.parseInt(hex, 16);
  return (zeroIsInvalid && codePoint === 0) || codePoint > 0x10_ffff
    ? "\u{FFFD}"
    : String.fromCodePoint(codePoint);
}

function lineIndex(text: string, firstLine: number): (offset: number) => number {
  const breaks: number[] = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    breaks.push(index);
  }
  return (offset) => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((breaks[middle] ?? 0) < offset) low = middle + 1;
      else high = middle;
    }
    return firstLine + low;
  };
}

function matchesAt(text: string, index: number, token: string): boolean {
  return text.slice(index, index + token.length).toLowerCase() === token;
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
  return cursor;
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" ||
    character === "\r" || character === "\f";
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\w-]/u.test(character);
}

function attribute(tag: TagToken, name: string): string | null {
  return tag.attrs.find((candidate) => candidate.name === name)?.value ?? null;
}

function isClassicOrModuleScript(tag: TagToken): boolean {
  if (attribute(tag, "src") !== null) return false;
  const type = attribute(tag, "type")?.trim().toLowerCase() ?? "";
  return scriptTypes.has(type);
}
