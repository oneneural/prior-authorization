// A JSON reader that keeps the exact source text of every scalar, so that an
// extracted fact can quote the source (EvidenceFact.originalText) rather than a
// re-serialization of the parsed value. Values follow JSON.parse semantics,
// including "last duplicate key wins".

export type JsonScalar = string | number | boolean | null;

export type SourceNode =
  | { kind: 'object'; members: ReadonlyMap<string, SourceNode> }
  | { kind: 'array'; items: readonly SourceNode[] }
  | { kind: 'scalar'; value: JsonScalar; raw: string };

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// Finds the extent of a string token; JSON.parse then rejects bad escapes and control characters.
const STRING = /"(?:[^"\\]|\\.)*"/y;
const LITERALS: readonly (readonly [string, JsonScalar])[] = [
  ['true', true],
  ['false', false],
  ['null', null],
];

class Reader {
  position = 0;

  constructor(private readonly text: string) {}

  fail(expected: string): never {
    throw new SyntaxError(`expected ${expected} at position ${this.position}`);
  }

  skipWhitespace() {
    while (WHITESPACE.has(this.text[this.position] ?? '')) {
      this.position += 1;
    }
  }

  match(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.position;
    const found = pattern.exec(this.text);
    if (found === null) {
      return undefined;
    }
    this.position += found[0].length;
    return found[0];
  }

  expect(character: string) {
    if (this.text[this.position] !== character) {
      this.fail(`'${character}'`);
    }
    this.position += 1;
  }

  value(): SourceNode {
    this.skipWhitespace();
    const next = this.text[this.position];
    if (next === '{') {
      return this.object();
    }
    if (next === '[') {
      return this.array();
    }
    if (next === '"') {
      const raw = this.match(STRING) ?? this.fail('a string');
      return { kind: 'scalar', value: JSON.parse(raw) as string, raw };
    }
    for (const [literal, value] of LITERALS) {
      if (this.text.startsWith(literal, this.position)) {
        this.position += literal.length;
        return { kind: 'scalar', value, raw: literal };
      }
    }
    const raw = this.match(NUMBER) ?? this.fail('a JSON value');
    return { kind: 'scalar', value: Number(raw), raw };
  }

  object(): SourceNode {
    this.expect('{');
    const members = new Map<string, SourceNode>();
    this.skipWhitespace();
    if (this.text[this.position] === '}') {
      this.position += 1;
      return { kind: 'object', members };
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.match(STRING) ?? this.fail('a member name');
      this.skipWhitespace();
      this.expect(':');
      const name = JSON.parse(key) as string;
      members.delete(name);
      members.set(name, this.value());
      this.skipWhitespace();
      if (this.text[this.position] === ',') {
        this.position += 1;
        continue;
      }
      this.expect('}');
      return { kind: 'object', members };
    }
  }

  array(): SourceNode {
    this.expect('[');
    const items: SourceNode[] = [];
    this.skipWhitespace();
    if (this.text[this.position] === ']') {
      this.position += 1;
      return { kind: 'array', items };
    }
    for (;;) {
      items.push(this.value());
      this.skipWhitespace();
      if (this.text[this.position] === ',') {
        this.position += 1;
        continue;
      }
      this.expect(']');
      return { kind: 'array', items };
    }
  }
}

/** Reads one complete JSON text; throws SyntaxError when it is not valid JSON. */
export function readJsonSource(text: string): SourceNode {
  const reader = new Reader(text);
  const root = reader.value();
  reader.skipWhitespace();
  if (reader.position !== text.length) {
    reader.fail('the end of the JSON text');
  }
  return root;
}

/** The node at an RFC 6901 JSON Pointer, or `undefined` when it does not resolve. */
export function nodeAt(root: SourceNode, pointer: string): SourceNode | undefined {
  if (pointer === '') {
    return root;
  }
  if (!pointer.startsWith('/')) {
    return undefined;
  }
  let current: SourceNode | undefined = root;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current?.kind === 'object') {
      current = current.members.get(token);
    } else if (current?.kind === 'array' && /^(0|[1-9][0-9]*)$/.test(token)) {
      current = current.items[Number(token)];
    } else {
      return undefined;
    }
  }
  return current;
}
