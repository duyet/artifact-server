import {
  type DefaultTreeAdapterMap,
  parse,
} from "parse5";

type ParentNode = DefaultTreeAdapterMap["parentNode"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];

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

/** Collect every file reference an HTML document makes, inline styles and scripts included. */
export function scanHtml(text: string): ScannedHtmlDocument {
  const references: ScannedReference[] = [];
  let baseHref: string | null = null;

  const visit = (parent: ParentNode): void => {
    for (const node of parent.childNodes) {
      if (!isElement(node)) continue;
      if (node.tagName === "base" && baseHref === null) {
        baseHref = attribute(node, "href");
      }
      scanElementAttributes(node, references);
      if (node.tagName === "style") {
        for (const child of textChildren(node)) {
          references.push(...scanCss(child.value, child.line));
        }
      }
      if (node.tagName === "script" && isClassicOrModuleScript(node)) {
        for (const child of textChildren(node)) {
          references.push(...scanScript(child.value, child.line));
        }
      }
      if (node.tagName === "template" && "content" in node) {
        visit(node.content);
      }
      visit(node);
    }
  };
  visit(parse(text, {sourceCodeLocationInfo: true}));
  return {baseHref, references};
}

function scanElementAttributes(element: Element, references: ScannedReference[]): void {
  for (const {name, value} of element.attrs) {
    const line = element.sourceCodeLocation?.attrs?.[name]?.startLine ??
      element.sourceCodeLocation?.startLine ??
      1;
    const add = (raw: string, navigation = false): void => {
      references.push({kind: "html-attr", line, navigation, raw});
    };
    if (name === "src" || name === "poster" || name === "data-src") {
      add(value);
    } else if (srcsetAttributes.has(name)) {
      for (const candidate of srcsetUrls(value)) add(candidate);
    } else if (name === "href" && hrefElements.has(element.tagName)) {
      add(value, navigationElements.has(element.tagName));
    } else if (name === "data" && element.tagName === "object") {
      add(value);
    } else if (name === "style") {
      references.push(...scanCss(value, line));
    }
  }
  if (
    element.tagName === "meta" &&
    attribute(element, "http-equiv")?.trim().toLowerCase() === "refresh"
  ) {
    const target = refreshUrl(attribute(element, "content") ?? "");
    if (target !== null) {
      references.push({
        kind: "meta-refresh",
        line: element.sourceCodeLocation?.startLine ?? 1,
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
        raw = quoted.value;
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
      if (
        literal.value.length <= maximumScriptLiteralLength &&
        !(character === "`" && literal.value.includes("${")) &&
        assetLiteralPattern.test(literal.value)
      ) {
        references.push({
          kind: "script",
          line: lines(index),
          navigation: false,
          raw: literal.value,
        });
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
    while (index < value.length && /[\s,]/u.test(value[index] ?? "")) index += 1;
    const start = index;
    while (index < value.length && !/\s/u.test(value[index] ?? "")) index += 1;
    let url = value.slice(start, index);
    const trailingCommas = /,+$/u.exec(url);
    if (trailingCommas !== null) {
      url = url.slice(0, trailingCommas.index);
    } else {
      const descriptorEnd = value.indexOf(",", index);
      index = descriptorEnd === -1 ? value.length : descriptorEnd + 1;
    }
    if (url !== "") urls.push(url);
  }
  return urls;
}

function refreshUrl(content: string): string | null {
  const match = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/isu.exec(content);
  let target = match?.[1]?.trim() ?? "";
  const quote = target[0];
  if (quote === "\"" || quote === "'") {
    const end = target.indexOf(quote, 1);
    target = target.slice(1, end === -1 ? undefined : end);
  }
  return target === "" ? null : target;
}

/** A value read from source text and the offset just past it. */
interface LexedValue {
  readonly end: number;
  readonly value: string;
}

/** The text of one child node and the line it starts on. */
interface TextChild {
  readonly line: number;
  readonly value: string;
}

function readUrlFunction(text: string, start: number): LexedValue {
  let index = skipWhitespace(text, start + "url(".length);
  if (text[index] === "\"" || text[index] === "'") {
    const quoted = readQuoted(text, index);
    const close = text.indexOf(")", quoted.end);
    return {end: close === -1 ? text.length : close + 1, value: quoted.value};
  }
  let value = "";
  while (index < text.length && text[index] !== ")") {
    if (text[index] === "\\" && index + 1 < text.length) index += 1;
    value += text[index];
    index += 1;
  }
  return {end: Math.min(index + 1, text.length), value: value.trim()};
}

/** Read a quoted literal from its opening quote; an unterminated one ends at the line break. */
function readQuoted(text: string, start: number): LexedValue {
  const quote = text[start];
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === quote) return {end: index + 1, value};
    if (character === "\n" && quote !== "`") return {end: index, value};
    if (character === "\\" && index + 1 < text.length) {
      index += 1;
      value += text[index];
    } else {
      value += character;
    }
    index += 1;
  }
  return {end: index, value};
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
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\w-]/u.test(character);
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((candidate) => candidate.name === name)?.value ?? null;
}

function textChildren(element: Element): readonly TextChild[] {
  return element.childNodes.flatMap((child) =>
    child.nodeName === "#text" && "value" in child
      ? [{line: child.sourceCodeLocation?.startLine ?? 1, value: child.value}]
      : []
  );
}

function isClassicOrModuleScript(element: Element): boolean {
  if (attribute(element, "src") !== null) return false;
  const type = attribute(element, "type")?.trim().toLowerCase() ?? "";
  return scriptTypes.has(type);
}
