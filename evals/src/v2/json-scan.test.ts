import { describe, expect, it } from 'vitest';

import { scanJson } from './json-scan.js';

// The raw-token scanner behind exact-text checks and pad placeholder placement.

describe('scanJson', () => {
  it('records the raw token of every scalar by JSON Pointer', () => {
    const scan = scanJson('{"a": 1.0, "b": [true, null, -2e3], "c/d": {"e~f": "x\\u0041"}}');
    expect(scan?.value).toEqual({ a: 1, b: [true, null, -2000], 'c/d': { 'e~f': 'xA' } });
    expect(scan?.scalars.get('/a')).toEqual({ pointer: '/a', kind: 'number', raw: '1.0' });
    expect(scan?.scalars.get('/b/2')?.raw).toBe('-2e3');
    expect(scan?.scalars.get('/b/1')?.kind).toBe('null');
    expect(scan?.scalars.get('/c~1d/e~0f')).toEqual({ pointer: '/c~1d/e~0f', kind: 'string', raw: '"x\\u0041"' });
  });

  it('records string value spans and their escapes, but not keys', () => {
    const text = '{"key": "ab\\ncd"}';
    const scan = scanJson(text);
    expect(scan?.strings).toHaveLength(1);
    const span = scan?.strings[0];
    expect(text.slice(span?.contentStart, span?.contentEnd)).toBe('ab\\ncd');
    expect(span?.escapes.map(([start, end]) => text.slice(start, end))).toEqual(['\\n']);
  });

  it('keeps the last value of a repeated key, as JSON.parse does', () => {
    const scan = scanJson('{"a": "first", "a": "second"}');
    expect(scan?.value).toEqual(JSON.parse('{"a": "first", "a": "second"}'));
    expect(scan?.scalars.get('/a')?.raw).toBe('"second"');
    expect(scan?.strings.map((span) => span.pointer)).toEqual(['/a']);
  });

  it('forgets everything recorded under a value that a repeated key overwrites', () => {
    const scan = scanJson('{"a": {"b": 1, "c": "text"}, "ab": "kept", "a": 2}');
    expect(scan?.value).toEqual({ a: 2, ab: 'kept' });
    expect([...(scan?.scalars.keys() ?? [])].sort()).toEqual(['/a', '/ab']);
    expect(scan?.scalars.get('/a')?.raw).toBe('2');
    expect(scan?.strings.map((span) => span.pointer)).toEqual(['/ab']);
  });

  it('rejects anything that is not strict RFC 8259 JSON', () => {
    for (const text of ['', '{', '{"a": 01}', '{"a": .5}', '{"a": 1,}', "{'a': 1}", '{"a": "\\x"}', '{"a": "\u0001"}', '[1] 2', 'NaN', '{"a": "\\u12"}', '\ufeff{}']) {
      expect(scanJson(text), JSON.stringify(text)).toBeNull();
    }
    expect(scanJson(' [] ')?.value).toEqual([]);
  });
});
