import { describe, expect, it } from 'vitest';

import { nodeAt, readJsonSource } from './json-source.js';

describe('JSON source reader', () => {
  it('keeps the exact source text of scalars', () => {
    const root = readJsonSource('{ "a": 1.0, "b": 1e0, "c": "tab\\tand \\u00e9", "d": [true, null], "e": -0 }');
    expect(nodeAt(root, '/a')).toEqual({ kind: 'scalar', value: 1, raw: '1.0' });
    expect(nodeAt(root, '/b')).toEqual({ kind: 'scalar', value: 1, raw: '1e0' });
    expect(nodeAt(root, '/c')).toEqual({ kind: 'scalar', value: 'tab\tand é', raw: '"tab\\tand \\u00e9"' });
    expect(nodeAt(root, '/d/0')).toEqual({ kind: 'scalar', value: true, raw: 'true' });
    expect(nodeAt(root, '/d/1')).toEqual({ kind: 'scalar', value: null, raw: 'null' });
    expect(nodeAt(root, '/e')).toEqual({ kind: 'scalar', value: -0, raw: '-0' });
  });

  it('follows JSON.parse for duplicate keys and agrees with it on values', () => {
    const text = '{"k": "first", "k": "last", "nested": {"x": [1, {"y": "z"}]}}';
    const root = readJsonSource(text);
    expect(nodeAt(root, '/k')).toMatchObject({ value: 'last' });
    expect(nodeAt(root, '/nested/x/1/y')).toMatchObject({ value: (JSON.parse(text) as { nested: { x: [number, { y: string }] } }).nested.x[1].y });
  });

  it('resolves RFC 6901 escapes and refuses non-resolving pointers', () => {
    const root = readJsonSource('{"a/b": {"m~n": 5}, "list": [0]}');
    expect(nodeAt(root, '/a~1b/m~0n')).toMatchObject({ value: 5 });
    expect(nodeAt(root, '')).toBe(root);
    for (const pointer of ['/missing', '/list/1', '/list/01', '/list/-', 'a~1b', '/a~1b/m~0n/deeper']) {
      expect(nodeAt(root, pointer)).toBeUndefined();
    }
  });

  it('rejects text that is not one valid JSON value', () => {
    for (const text of ['', '{', '{"a": 1,}', '[1 2]', '{"a": 01}', '"unterminated', '{"a": "bad \\x escape"}', '{"a": 1} trailing', '{"a": "line\nbreak"}', 'nul']) {
      expect(() => readJsonSource(text), text).toThrow(SyntaxError);
    }
  });
});
