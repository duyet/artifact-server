import type {Bytes} from "./bytes.js";

export type LineEnding = "crlf" | "lf";

/** One text file split into what the editor shows and what it must preserve. */
export interface DecodedText {
  /** True when the file began with a UTF-8 byte order mark. */
  readonly bom: boolean;
  readonly lineEnding: LineEnding;
  /** Editor text: the BOM is removed and every line ends with a bare "\n". */
  readonly text: string;
}

export type UnsupportedTextReason =
  | "invalid_utf8"
  | "mixed_line_endings";

/** A file the editor cannot round-trip byte for byte, so it refuses to open it. */
export class UnsupportedTextError extends Error {
  readonly reason: UnsupportedTextReason;

  constructor(reason: UnsupportedTextReason, message: string) {
    super(message);
    this.name = "UnsupportedTextError";
    this.reason = reason;
  }
}

const byteOrderMark = [0xef, 0xbb, 0xbf] as const;

function hasByteOrderMark(bytes: Uint8Array): boolean {
  return byteOrderMark.every((byte, index) => bytes[index] === byte);
}

/**
 * Decodes UTF-8 text for editing. Files whose line endings are mixed, or that
 * are not valid UTF-8, are refused: normalizing them on save would rewrite
 * lines the author never touched.
 */
export function decodeEditableText(bytes: Uint8Array): DecodedText {
  const bom = hasByteOrderMark(bytes);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(
      bom ? bytes.subarray(byteOrderMark.length) : bytes,
    );
  } catch {
    throw new UnsupportedTextError(
      "invalid_utf8",
      "This file is not valid UTF-8 text, so it cannot be edited here.",
    );
  }
  const crlfCount = raw.match(/\r\n/gu)?.length ?? 0;
  const lfCount = (raw.match(/\n/gu)?.length ?? 0) - crlfCount;
  const loneCarriageReturns = raw.replace(/\r\n/gu, "").includes("\r");
  if ((crlfCount > 0 && lfCount > 0) || loneCarriageReturns) {
    throw new UnsupportedTextError(
      "mixed_line_endings",
      "This file mixes line-ending styles, so saving it here would rewrite lines you did not change.",
    );
  }
  return {
    bom,
    lineEnding: crlfCount > 0 ? "crlf" : "lf",
    text: crlfCount > 0 ? raw.replace(/\r\n/gu, "\n") : raw,
  };
}

/** Re-applies the original BOM and line-ending style to edited editor text. */
export function encodeEditableText(
  edited: {readonly text: string} & Pick<DecodedText, "bom" | "lineEnding">,
): Bytes {
  const normalized = edited.text.replace(/\r\n?/gu, "\n");
  const body = new TextEncoder().encode(
    edited.lineEnding === "crlf" ? normalized.replace(/\n/gu, "\r\n") : normalized,
  );
  if (!edited.bom) return body;
  const bytes = new Uint8Array(byteOrderMark.length + body.length);
  bytes.set(byteOrderMark, 0);
  bytes.set(body, byteOrderMark.length);
  return bytes;
}
