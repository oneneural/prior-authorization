import { join } from 'node:path';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from './fixture.js';

// Repeatable probes of the @pa/domain purity guard. Each probe
// is linted as in-memory text at a virtual path under packages/domain, so no
// file is written to the tree. TypeScript probes run without type information,
// once with the parser's default libraries (globals are unresolved references)
// and once with the domain's es2024 and DOM libraries (globals are implicit lib
// variables); JavaScript probes see Node's configured globals. The real
// SHA-256 path is linted with full type information. This is a static
// engineering guard, not a sandbox.

const PURITY_RULES = new Set(['boundaries/pure-domain-globals', 'boundaries/pure-domain-imports', 'no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax']);
const LINT_TIMEOUT = 60_000;

const withoutTypes = (parserOptions: Linter.ParserOptions = {}): Linter.Config[] => [
  { files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked },
  { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: false, ...parserOptions } } },
];

const VARIANTS = [
  { name: 'TypeScript, default libraries', file: 'purity-probe.ts', config: withoutTypes() },
  { name: 'TypeScript, domain libraries', file: 'purity-probe.ts', config: withoutTypes({ lib: ['es2024', 'dom'] }) },
  { name: 'JavaScript, Node globals', file: 'purity-probe.js', config: [] },
] as const;

const linters = new Map<string, ESLint>();

beforeAll(() => {
  for (const variant of VARIANTS) {
    linters.set(variant.name, new ESLint({ cwd: REPO_ROOT, overrideConfig: [...variant.config] }));
  }
}, LINT_TIMEOUT);

async function purityErrors(variant: (typeof VARIANTS)[number], code: string): Promise<string[]> {
  const linter = linters.get(variant.name);
  if (linter === undefined) {
    throw new Error(`no linter for ${variant.name}`);
  }
  const [result] = await linter.lintText(code, { filePath: join(REPO_ROOT, 'packages/domain/src', variant.file) });
  const messages = result?.messages ?? [];
  const fatal = messages.filter((message) => message.fatal === true);
  if (fatal.length > 0) {
    throw new Error(`probe did not parse: ${fatal.map((message) => message.message).join('; ')}`);
  }
  return messages.filter((message) => message.ruleId !== null && PURITY_RULES.has(message.ruleId)).map((message) => `${message.ruleId}: ${message.message}`);
}

// Each probe must fail the guard on its own; `bytes`, `name`, `key` and `x` are
// local parameters. Probe bodies carry no type syntax, so the same text is
// valid TypeScript and JavaScript; probes are linted, never type-checked.
const wrap = (body: string) => `export function probe(bytes: Uint8Array, name: string, key: string, x: number) {\n  ${body}\n  return [bytes, name, key, x];\n}\n`;
const wrapJs = (body: string) => `export function probe(bytes, name, key, x) {\n  ${body}\n  return [bytes, name, key, x];\n}\n`;

const ESCAPES: Record<string, string> = {
  'crypto dot randomUUID': 'crypto.randomUUID();',
  'crypto bracket randomUUID': "crypto['randomUUID']();",
  'crypto template randomUUID': 'crypto[`randomUUID`]();',
  'crypto dynamic member': 'crypto[name]();',
  'globalThis crypto randomUUID': 'globalThis.crypto.randomUUID();',
  'globalThis bracket getRandomValues': "globalThis['crypto'].getRandomValues(new Uint8Array(1));",
  'getRandomValues on any object': 'const source = { getRandomValues: (b) => b }; source.getRandomValues(bytes);',
  'crypto destructuring': 'const { randomUUID } = crypto; randomUUID();',
  'crypto subtle destructuring': 'const { subtle } = crypto; void subtle;',
  'crypto alias': 'const c = crypto; void c.subtle;',
  'crypto non-digest call': "void crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);",
  'digest without a call': 'const digest = crypto.subtle.digest; void digest;',
  'globalThis alias': 'const g = globalThis; void g.Date;',
  'globalThis destructuring': 'const { Date: Clock } = globalThis; void Clock;',
  'globalThis bracket clock': "void globalThis['Date'].now();",
  'globalThis dynamic member': 'void globalThis[name];',
  'globalThis performance': 'void globalThis.performance.now();',
  'globalThis navigator': 'void globalThis.navigator;',
  'self crypto': 'void self.crypto.randomUUID();',
  'window clock': 'void window.Date.now();',
  'document access': 'void document.cookie;',
  'location access': 'void location.href;',
  'Math random dot': 'void Math.random();',
  'Math random bracket': "void Math['random']();",
  'Math random destructuring': 'const { random } = Math; void random();',
  'Math alias': 'const M = Math; void M.random();',
  'Math dynamic member': 'void Math[key];',
  'Reflect read': "void Reflect.get(Math, 'random');",
  'eval': "void eval('Date');",
  'Function constructor': "void new Function('return Date')();",
  'Function constructor through a function value': "void (() => undefined).constructor('return Date')();",
  'Function constructor through a constructor': "void [].constructor.constructor('return Date')();",
  'Date constructor': 'void new Date();',
  'Date now': 'void Date.now();',
  'performance now': 'void performance.now();',
  'Temporal now': 'void Temporal.Now;',
  'time zone through Intl': 'void Intl.DateTimeFormat().resolvedOptions().timeZone;',
  'time zone offset bracket': "void bytes['getTimezoneOffset']();",
  'locale compare': "void 'a'.localeCompare('b');",
  'locale bracket': "void 'a'['toLocaleUpperCase']();",
  'locale destructuring': 'const { toLocaleString } = x; void toLocaleString;',
  'import.meta': 'void import.meta.url;',
  'process environment': 'void process.env.HOME;',
  'globalThis process': 'void globalThis.process;',
  'timer': 'setTimeout(() => undefined, 0);',
  'node built-in import': "void import('node:fs');",
};

const PERMITTED: Record<string, string> = {
  'globalThis digest': "void globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));",
  'crypto digest': "void crypto.subtle.digest('SHA-256', new Uint8Array(bytes));",
  'injected hasher': 'const sha256 = async (input) => String(input.byteLength); void sha256(bytes);',
  'static Math members': 'void Math.max(x, Math.floor(x / 2), Math.PI);',
  'code-unit comparison': "void ('a' < 'b');",
  'local named like a member': 'const random = x; void random;',
  'class constructor method': 'class Box { constructor(value) { this.value = value; } } void new Box(x);',
};

describe.each(VARIANTS)('domain purity guard: $name', (variant) => {
  const source = (body: string) => (variant.file.endsWith('.js') ? wrapJs(body) : wrap(body));

  it.each(Object.entries(ESCAPES))(
    'rejects %s',
    async (_label, body) => {
      expect(await purityErrors(variant, source(body))).not.toEqual([]);
    },
    LINT_TIMEOUT,
  );

  it.each(Object.entries(PERMITTED))(
    'permits %s',
    async (_label, body) => {
      expect(await purityErrors(variant, source(body))).toEqual([]);
    },
    LINT_TIMEOUT,
  );
});

describe('domain purity guard on the real SHA-256 path', () => {
  it(
    'passes hash.ts with full type information',
    async () => {
      const linter = new ESLint({ cwd: REPO_ROOT });
      const [result] = await linter.lintFiles([join(REPO_ROOT, 'packages/domain/src/hash.ts')]);
      expect(result?.errorCount).toBe(0);
      expect(result?.fatalErrorCount).toBe(0);
    },
    LINT_TIMEOUT,
  );
});
