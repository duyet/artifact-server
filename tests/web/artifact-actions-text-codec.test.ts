import {describe, expect, test} from "vitest";

import {
  decodeEditableText,
  encodeEditableText,
  UnsupportedTextError,
} from "../../apps/web/src/artifact-actions/text-codec.js";

const encoder = new TextEncoder();
const bom = [0xef, 0xbb, 0xbf];

/** What decoding the bytes throws, so a test can assert on the failure itself. */
function decodeFailure(bytes: Uint8Array): Error | undefined {
  try {
    decodeEditableText(bytes);
  } catch (caught) {
    return caught instanceof Error ? caught : undefined;
  }
  return undefined;
}

/** Decodes, replaces one line the way the editor would, and re-encodes. */
function editLine(bytes: Uint8Array, lineIndex: number, replacement: string): Uint8Array {
  const decoded = decodeEditableText(bytes);
  const lines = decoded.text.split("\n");
  lines[lineIndex] = replacement;
  return encodeEditableText({...decoded, text: lines.join("\n")});
}

describe("editable text codec", () => {
  test("an untouched LF file without a BOM round-trips byte for byte", () => {
    const original = encoder.encode("alpha\nbeta\ngamma\n");
    const decoded = decodeEditableText(original);

    expect(decoded).toEqual({bom: false, lineEnding: "lf", text: "alpha\nbeta\ngamma\n"});
    expect(encodeEditableText(decoded)).toEqual(original);
  });

  test("an untouched CRLF file with a BOM round-trips byte for byte", () => {
    const original = Uint8Array.from([...bom, ...encoder.encode("alpha\r\nbeta\r\ngamma\r\n")]);
    const decoded = decodeEditableText(original);

    expect(decoded).toEqual({bom: true, lineEnding: "crlf", text: "alpha\nbeta\ngamma\n"});
    expect(encodeEditableText(decoded)).toEqual(original);
  });

  test("changing one line of a CRLF file with a BOM leaves every other byte identical", () => {
    const original = Uint8Array.from([...bom, ...encoder.encode("alpha\r\nbeta\r\ngamma")]);

    expect(editLine(original, 1, "BETA edited")).toEqual(
      Uint8Array.from([...bom, ...encoder.encode("alpha\r\nBETA edited\r\ngamma")]),
    );
  });

  test("changing one line of an LF file without a BOM leaves every other byte identical", () => {
    const original = encoder.encode("alpha\nbeta\ngamma\n");

    expect(editLine(original, 0, "ALPHA")).toEqual(encoder.encode("ALPHA\nbeta\ngamma\n"));
  });

  test("a BOM is kept on an LF file and absent on a CRLF file when the source had it that way", () => {
    const lfWithBom = Uint8Array.from([...bom, ...encoder.encode("a\nb\n")]);
    const crlfWithoutBom = encoder.encode("a\r\nb\r\n");

    expect(encodeEditableText(decodeEditableText(lfWithBom))).toEqual(lfWithBom);
    expect(encodeEditableText(decodeEditableText(crlfWithoutBom))).toEqual(crlfWithoutBom);
  });

  test("lines the editor adds take the file's line ending, including multibyte text", () => {
    const original = encoder.encode("héllo\r\n");
    const decoded = decodeEditableText(original);

    expect(encodeEditableText({...decoded, text: "héllo\nwörld ✓\n"}))
      .toEqual(encoder.encode("héllo\r\nwörld ✓\r\n"));
  });

  test("text pasted with CRLF into an LF file is stored with LF only", () => {
    const decoded = decodeEditableText(encoder.encode("a\n"));

    expect(encodeEditableText({...decoded, text: "a\r\nb\r\n"})).toEqual(encoder.encode("a\nb\n"));
  });

  test("a file without any newline decodes as LF and keeps its missing trailing newline", () => {
    const original = encoder.encode("single line");

    expect(decodeEditableText(original).lineEnding).toBe("lf");
    expect(encodeEditableText(decodeEditableText(original))).toEqual(original);
  });

  test("a file that mixes LF and CRLF is refused instead of silently normalized", () => {
    const mixed = encoder.encode("a\r\nb\nc\r\n");

    const failure = decodeFailure(mixed);

    expect(failure).toBeInstanceOf(UnsupportedTextError);
    expect(failure).toMatchObject({reason: "mixed_line_endings"});
  });

  test("a lone carriage return is refused as mixed line endings", () => {
    expect(() => decodeEditableText(encoder.encode("a\rb\n")))
      .toThrowError(/mixes line-ending styles/u);
  });

  test("bytes that are not valid UTF-8 are refused", () => {
    const failure = decodeFailure(Uint8Array.from([0x61, 0xff, 0xfe, 0x62]));

    expect(failure).toBeInstanceOf(UnsupportedTextError);
    expect(failure).toMatchObject({reason: "invalid_utf8"});
  });
});
