// A strict RFC 8259 scanner that records where each value is written.
// `JSON.parse` loses the source text of a value (`1.0` becomes 1), so exact-text
// checks read the raw token here, and `pad` uses the string spans to prove that
// its placeholder lies inside one JSON string value. Offsets are UTF-16 code
// units of the scanned text. A key that repeats keeps its last value, as
// `JSON.parse` does.

export type ScalarKind = 'string' | 'number' | 'boolean' | 'null';

export interface ScalarToken {
  pointer: string;
  kind: ScalarKind;
  /** The token exactly as written, including the quotes of a string. */
  raw: string;
}

export interface StringValueSpan {
  pointer: string;
  /** Offsets of the text between the quotes. */
  contentStart: number;
  contentEnd: number;
  /** `[start, end)` of every escape sequence inside the string. */
  escapes: readonly (readonly [number, number])[];
}

export interface JsonScan {
  value: unknown;
  scalars: ReadonlyMap<string, ScalarToken>;
  strings: readonly StringValueSpan[];
}

class InvalidJson extends Error {}

const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

const pointerToken = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

class Scanner {
  index = 0;
  readonly scalars = new Map<string, ScalarToken>();
  readonly strings: StringValueSpan[] = [];

  constructor(private readonly text: string) {}

  fail(): never {
    throw new InvalidJson();
  }

  skipWhitespace() {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text.charAt(this.index))) {
      this.index += 1;
    }
  }

  expect(character: string) {
    if (this.text.charAt(this.index) !== character) {
      this.fail();
    }
    this.index += 1;
  }

  /** Scans a string token starting at its opening quote. */
  string(): { start: number; contentStart: number; contentEnd: number; escapes: [number, number][] } {
    const start = this.index;
    this.expect('"');
    const escapes: [number, number][] = [];
    for (;;) {
      if (this.index >= this.text.length) {
        this.fail();
      }
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        const contentEnd = this.index;
        this.index += 1;
        return { start, contentStart: start + 1, contentEnd, escapes };
      }
      if (code < 0x20) {
        this.fail();
      }
      if (code === 0x5c) {
        const next = this.text.charAt(this.index + 1);
        const length = SIMPLE_ESCAPES.has(next) ? 2 : next === 'u' && HEX4.test(this.text.slice(this.index + 2, this.index + 6)) ? 6 : 0;
        if (length === 0) {
          this.fail();
        }
        escapes.push([this.index, this.index + length]);
        this.index += length;
      } else {
        this.index += 1;
      }
    }
  }

  literal(word: 'true' | 'false' | 'null', pointer: string) {
    if (!this.text.startsWith(word, this.index)) {
      this.fail();
    }
    this.index += word.length;
    this.scalars.set(pointer, { pointer, kind: word === 'null' ? 'null' : 'boolean', raw: word });
  }

  value(pointer: string) {
    this.skipWhitespace();
    const character = this.text.charAt(this.index);
    if (character === '{') {
      this.object(pointer);
    } else if (character === '[') {
      this.array(pointer);
    } else if (character === '"') {
      const token = this.string();
      this.strings.push({ pointer, contentStart: token.contentStart, contentEnd: token.contentEnd, escapes: token.escapes });
      this.scalars.set(pointer, { pointer, kind: 'string', raw: this.text.slice(token.start, this.index) });
    } else if (character === 't' || character === 'f' || character === 'n') {
      this.literal(character === 't' ? 'true' : character === 'f' ? 'false' : 'null', pointer);
    } else {
      NUMBER.lastIndex = this.index;
      const match = NUMBER.exec(this.text);
      if (match === null || match[0] === '' || match[0] === '-') {
        this.fail();
      }
      this.index += match[0].length;
      this.scalars.set(pointer, { pointer, kind: 'number', raw: match[0] });
    }
  }

  object(pointer: string) {
    this.expect('{');
    this.skipWhitespace();
    if (this.text.charAt(this.index) === '}') {
      this.index += 1;
      return;
    }
    const names = new Set<string>();
    for (;;) {
      this.skipWhitespace();
      const key = this.string();
      const name = JSON.parse(this.text.slice(key.start, this.index)) as string;
      this.skipWhitespace();
      this.expect(':');
      const member = `${pointer}/${pointerToken(name)}`;
      if (names.has(name)) {
        this.discard(member);
      }
      names.add(name);
      this.value(member);
      this.skipWhitespace();
      if (this.text.charAt(this.index) === '}') {
        this.index += 1;
        return;
      }
      this.expect(',');
    }
  }

  /** Forgets everything recorded at or under `pointer`, whose value a repeated key overwrites. */
  discard(pointer: string) {
    const under = (candidate: string) => candidate === pointer || candidate.startsWith(`${pointer}/`);
    for (const key of [...this.scalars.keys()].filter(under)) {
      this.scalars.delete(key);
    }
    const kept = this.strings.filter((span) => !under(span.pointer));
    this.strings.splice(0, this.strings.length, ...kept);
  }

  array(pointer: string) {
    this.expect('[');
    this.skipWhitespace();
    if (this.text.charAt(this.index) === ']') {
      this.index += 1;
      return;
    }
    for (let position = 0; ; position += 1) {
      this.value(`${pointer}/${position}`);
      this.skipWhitespace();
      if (this.text.charAt(this.index) === ']') {
        this.index += 1;
        return;
      }
      this.expect(',');
    }
  }
}

/** Scans one JSON text, or returns `null` when it is not valid RFC 8259 JSON. */
export function scanJson(text: string): JsonScan | null {
  const scanner = new Scanner(text);
  try {
    scanner.value('');
    scanner.skipWhitespace();
    if (scanner.index !== text.length) {
      return null;
    }
  } catch (error) {
    if (error instanceof InvalidJson) {
      return null;
    }
    throw error;
  }
  return { value: JSON.parse(text) as unknown, scalars: scanner.scalars, strings: scanner.strings };
}
