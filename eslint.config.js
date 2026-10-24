import { builtinModules } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// One extension set per language, so every lint block covers the same module variants.
const TS = '{ts,tsx,mts,cts}';
const JS = '{js,jsx,mjs,cjs}';

// Server persistence, queue, HTTP-server and model-provider modules. Browser-adjacent
// code (web app and lib, contracts) must never import them. This list is the single
// source for both the import patterns and the resolved-path rule below.
const SERVER_ONLY_MODULES = [
  { packages: ['@pa/db'], message: 'Web and contract code must not import the database package.' },
  { packages: ['@pa/api', '@pa/worker'], message: 'Call the API over HTTP instead of importing a service.' },
  { packages: ['pg', 'pg-boss', 'drizzle-orm', 'fastify'], message: 'Server-only module.' },
  { packages: ['langchain'], scopes: ['@anthropic-ai', '@langchain'], message: 'Provider modules belong to the worker only.' },
];

const SERVER_ONLY = SERVER_ONLY_MODULES.map(({ packages, scopes = [], message }) => ({
  group: [...packages.flatMap((name) => [name, `${name}/*`]), ...scopes.map((scope) => `${scope}/*`)],
  message,
}));

// The root `@pa/config` entry reads secrets; only its secret-free topology subpath is allowed.
const SECRET_CONFIG = { name: '@pa/config', message: 'Import @pa/config/topology; the root entry reads secrets.' };

const restrict = (patterns, paths = []) => ({
  'no-restricted-imports': 'off',
  '@typescript-eslint/no-restricted-imports': ['error', { patterns, paths }],
});

// JavaScript files have no typescript-eslint plugin, so they use the core rule.
const restrictJs = (patterns, paths = []) => ({ 'no-restricted-imports': ['error', { patterns, paths }] });

/** The same import restriction for the TypeScript and JavaScript files under each directory glob. */
const restrictBoth = (directories, patterns, paths = [], ignores = []) => [
  { files: directories.map((directory) => `${directory}/*.${TS}`), ignores, rules: restrict(patterns, paths) },
  { files: directories.map((directory) => `${directory}/*.${JS}`), ignores, rules: restrictJs(patterns, paths) },
];

// Package-name patterns cannot see relative imports or require(), so this rule
// resolves each relative specifier against the importing file, classifies paths
// through node_modules by package name, and also checks require() specifiers.
const SERVER_ONLY_DIRECTORIES = ['packages/db', 'apps/api', 'apps/worker'];
const SECRET_CONFIG_DIRECTORY = /^packages\/config(\/(src|dist)(\/index(\.[cm]?[jt]sx?)?)?)?\/?$/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SERVER_ONLY_PACKAGE = new RegExp(
  `^(${SERVER_ONLY_MODULES.flatMap(({ packages, scopes = [] }) => [
    ...packages.map(escapeRegExp),
    ...scopes.map((scope) => `${escapeRegExp(scope)}/[^/]+`),
  ]).join('|')})(/|$)`,
);
const SECRET_CONFIG_PACKAGE = /^@pa\/config(\/(src|dist)(\/index(\.[cm]?[jt]sx?)?)?)?\/?$/;

/** Returns the violation for a specifier, or undefined when it is allowed. */
function classify(source, filename, checkBare) {
  let target;
  if (source.startsWith('.')) {
    target = relative(import.meta.dirname, resolve(dirname(filename), source)).split(sep).join('/');
    const viaNodeModules = target.lastIndexOf('node_modules/');
    if (viaNodeModules === -1) {
      if (SERVER_ONLY_DIRECTORIES.some((directory) => target === directory || target.startsWith(`${directory}/`))) {
        return { messageId: 'serverOnly', target };
      }
      return SECRET_CONFIG_DIRECTORY.test(target) ? { messageId: 'secretConfig', target } : undefined;
    }
    target = target.slice(viaNodeModules + 'node_modules/'.length);
  } else if (checkBare) {
    target = source;
  } else {
    return undefined;
  }
  if (SERVER_ONLY_PACKAGE.test(target)) {
    return { messageId: 'serverOnly', target };
  }
  return SECRET_CONFIG_PACKAGE.test(target) ? { messageId: 'secretConfig', target } : undefined;
}

// Evaluator-owned fixtures, oracles and harness code (evals/, package @pa/evals) are
// invisible to runtime and domain code. Relative, absolute and node_modules paths
// are resolved; bare and require() specifiers are checked too.
const EVALS_PACKAGE = /^@pa\/evals(\/|$)/;

/** Returns the evals target a specifier reaches, or undefined when it is allowed. */
function evalsTarget(source, filename) {
  if (EVALS_PACKAGE.test(source)) {
    return source;
  }
  if (!source.startsWith('.') && !isAbsolute(source)) {
    return undefined;
  }
  const target = relative(import.meta.dirname, resolve(dirname(filename), source)).split(sep).join('/');
  const viaNodeModules = target.lastIndexOf('node_modules/');
  if (viaNodeModules !== -1) {
    const name = target.slice(viaNodeModules + 'node_modules/'.length);
    return EVALS_PACKAGE.test(name) ? name : undefined;
  }
  return target === 'evals' || target.startsWith('evals/') ? target : undefined;
}

// The deterministic domain is pure: besides its own files it imports only the
// contracts (and Vitest in its tests). Node built-ins, database, queue, HTTP,
// provider, configuration, app and evaluator modules are all outside the list.
const DOMAIN_DIRECTORY = 'packages/domain';
// The domain needs neither `Date` nor `Intl`: dates and instants are ISO
// strings, and these members read the environment's clock, time zone or locale.
const CLOCK_GLOBALS = ['Date', 'Intl', 'Temporal'];
const ENVIRONMENT_MEMBERS = ['getTimezoneOffset', 'resolvedOptions', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toLocaleUpperCase', 'toLocaleLowerCase', 'localeCompare'];
const CLOCK_MESSAGE = 'The domain has no clock, time zone or locale; the caller supplies the assessment date and dates are ISO strings.';
// Browser and Node global objects (each reaches every other global), dynamic
// evaluation and reflection are banned outright, so no alias of them exists.
const IMPURE_GLOBALS = [
  'process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'performance', 'navigator', 'localStorage', 'indexedDB',
  'window', 'self', 'global', 'document', 'location', 'top', 'parent', 'frames', 'opener', 'eval', 'Function', 'Reflect',
];
// Members that read randomness, a time zone or a locale, by any static name:
// dot or bracket access on any object, or a destructuring key.
const NONDETERMINISTIC_MEMBERS = new Set(['random', 'randomUUID', 'getRandomValues', ...ENVIRONMENT_MEMBERS]);
// Any function value's `constructor` is the Function constructor, which
// evaluates a string and so reaches every global; banned by the same names.
const REFLECTIVE_MEMBERS = new Set(['constructor']);
// Globals the domain may use only in one permitted shape (an allowlist, so an
// alias, destructuring, computed or other access fails): `globalThis` and
// `crypto` only as `[globalThis.]crypto.subtle.digest(...)`, the SHA-256 path,
// and `Math` only through a static member name.
const GUARDED_GLOBALS = new Set(['globalThis', 'crypto', 'Math']);

/** The static name of a member property or destructuring key, or undefined when it is computed from an expression. */
function staticName(node, computed) {
  if (!computed && node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  return node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;
}

/** The member expression whose object is `node`, if any. */
const memberOf = (node) => (node.parent?.type === 'MemberExpression' && node.parent.object === node ? node.parent : undefined);

/** True when `node` is the object of `.subtle.digest(...)`, called directly. */
function isDigestCall(node) {
  const subtle = memberOf(node);
  const digest = subtle !== undefined && staticName(subtle.property, subtle.computed) === 'subtle' ? memberOf(subtle) : undefined;
  return digest !== undefined && staticName(digest.property, digest.computed) === 'digest' && digest.parent?.type === 'CallExpression' && digest.parent.callee === digest;
}

/** True when a guarded global identifier appears in its permitted shape. */
function permittedGuardedUse(identifier) {
  const member = memberOf(identifier);
  if (identifier.name === 'Math') {
    return member !== undefined && staticName(member.property, member.computed) !== undefined;
  }
  if (identifier.name === 'crypto') {
    return isDigestCall(identifier);
  }
  return member !== undefined && staticName(member.property, member.computed) === 'crypto' && isDigestCall(member);
}
const DOMAIN_PACKAGES = new Set(['@pa/contracts']);
const DOMAIN_TEST_PACKAGES = new Set(['vitest']);
const NODE_BUILTINS = new Set(builtinModules);
const isDomainTest = (filename) => /\.test\.[cm]?[jt]sx?$/.test(filename) || relative(import.meta.dirname, filename).split(sep).join('/').startsWith(`${DOMAIN_DIRECTORY}/test/`);

/** Returns the violation for a domain specifier, or undefined when it is allowed. */
function domainViolation(source, filename) {
  if (source.startsWith('.') || isAbsolute(source)) {
    const target = relative(import.meta.dirname, resolve(dirname(filename), source)).split(sep).join('/');
    const inside = (target === DOMAIN_DIRECTORY || target.startsWith(`${DOMAIN_DIRECTORY}/`)) && !target.includes('node_modules/');
    return inside ? undefined : { messageId: 'outside', target };
  }
  if (source.startsWith('node:') || NODE_BUILTINS.has(source.split('/')[0])) {
    return { messageId: 'builtin', target: source };
  }
  if (DOMAIN_PACKAGES.has(source) || (isDomainTest(filename) && DOMAIN_TEST_PACKAGES.has(source))) {
    return undefined;
  }
  return { messageId: 'notAllowed', target: source };
}

const boundaries = {
  rules: {
    'pure-domain-imports': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          builtin: "'{{source}}' is a Node built-in; @pa/domain has no file system, network, clock or environment access.",
          notAllowed: "'{{source}}' is not on the @pa/domain allowlist (@pa/contracts, and vitest in tests); database, provider, app, configuration and evaluator modules are excluded.",
          outside: "'{{source}}' resolves outside packages/domain ({{target}}).",
          dynamic: 'A computed module specifier cannot be checked; @pa/domain imports only literal specifiers.',
        },
      },
      create(context) {
        function check(node) {
          if (node?.type !== 'Literal' || typeof node.value !== 'string') {
            context.report({ node: node ?? context.sourceCode.ast, messageId: 'dynamic' });
            return;
          }
          const violation = domainViolation(node.value, context.filename);
          if (violation !== undefined) {
            context.report({ node, messageId: violation.messageId, data: { source: node.value, target: violation.target } });
          }
        }
        const checkIfPresent = (node) => node.source !== null && check(node.source);
        return {
          ImportDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source),
          ExportNamedDeclaration: checkIfPresent,
          ExportAllDeclaration: (node) => check(node.source),
          'CallExpression[callee.type="Identifier"][callee.name="require"]': (node) => check(node.arguments[0]),
          TSExternalModuleReference: (node) => check(node.expression),
        };
      },
    },
    'pure-domain-globals': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          guarded:
            "'{{name}}' is allowed in @pa/domain only as {{shape}}; an alias, destructuring, computed or other access could reach randomness, a clock or the environment.",
          member: "'{{name}}' reads randomness, a time zone or a locale; @pa/domain is deterministic and has no clock or locale.",
          reflective: "'{{name}}' reaches the Function constructor and so every global; @pa/domain does not use it.",
        },
      },
      create(context) {
        const SHAPES = { globalThis: 'globalThis.crypto.subtle.digest(...)', crypto: 'crypto.subtle.digest(...)', Math: 'a static Math member' };
        function checkName(node, name) {
          if (name !== undefined && NONDETERMINISTIC_MEMBERS.has(name)) {
            context.report({ node, messageId: 'member', data: { name } });
          }
          if (name !== undefined && REFLECTIVE_MEMBERS.has(name)) {
            context.report({ node, messageId: 'reflective', data: { name } });
          }
        }
        function checkReference(reference) {
          // A type-only reference (typescript-eslint) reads nothing at run time.
          if (reference.isValueReference === false || permittedGuardedUse(reference.identifier)) {
            return;
          }
          const { name } = reference.identifier;
          context.report({ node: reference.identifier, messageId: 'guarded', data: { name, shape: SHAPES[name] } });
        }
        return {
          MemberExpression: (node) => checkName(node.property, staticName(node.property, node.computed)),
          'ObjectPattern > Property': (node) => checkName(node.key, staticName(node.key, node.computed)),
          // Guarded globals are lib or configured globals (variables without a
          // declaration) or unresolved references, as in no-restricted-globals.
          'Program:exit': (node) => {
            const scope = context.sourceCode.getScope(node);
            scope.variables
              .filter((variable) => variable.defs.length === 0 && GUARDED_GLOBALS.has(variable.name))
              .forEach((variable) => variable.references.forEach(checkReference));
            scope.through.filter((reference) => GUARDED_GLOBALS.has(reference.identifier.name)).forEach(checkReference);
          },
        };
      },
    },
    'no-evals-imports': {
      meta: {
        type: 'problem',
        schema: [],
        messages: { evals: "'{{source}}' reaches evaluator-owned code or data ({{target}}); runtime code must not read fixtures or oracles." },
      },
      create(context) {
        function check(node) {
          const source = node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
          const target = source === undefined ? undefined : evalsTarget(source, context.filename);
          if (target !== undefined) {
            context.report({ node, messageId: 'evals', data: { source, target } });
          }
        }
        return {
          ImportDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          'CallExpression[callee.type="Identifier"][callee.name="require"]': (node) => check(node.arguments[0]),
          TSExternalModuleReference: (node) => check(node.expression),
        };
      },
    },
    'no-server-imports': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          serverOnly: "'{{source}}' resolves to server-only code ({{target}}).",
          secretConfig: "'{{source}}' resolves to the secret-reading config entry ({{target}}); import @pa/config/topology.",
        },
      },
      create(context) {
        // Bare specifiers in import statements are left to no-restricted-imports;
        // require() is invisible to that rule, so it checks them here.
        function check(node, checkBare = false) {
          const source = node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
          const violation = source === undefined ? undefined : classify(source, context.filename, checkBare);
          if (violation !== undefined) {
            context.report({ node, messageId: violation.messageId, data: { source, target: violation.target } });
          }
        }
        return {
          ImportDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source, true),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          'CallExpression[callee.type="Identifier"][callee.name="require"]': (node) => check(node.arguments[0], true),
          TSExternalModuleReference: (node) => check(node.expression, true),
        };
      },
    },
  },
};

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/.next/',
    '**/next-env.d.ts',
    'packages/db/migrations/',
    // Documentation and non-workspace top-level directories are outside the TypeScript workspace.
    'docs/',
    'fixtures/',
    'prior_auth/',
    'tests/',
  ]),

  js.configs.recommended,

  {
    files: [`**/*.${TS}`],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },

  {
    files: [`**/*.${JS}`],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  {
    files: [`apps/web/**/*.${TS}`, `apps/web/**/*.${JS}`],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: 'apps/web/' } },
    rules: { ...nextPlugin.configs['core-web-vitals'].rules },
  },

  // Import boundaries. Everything the web build can include is covered, including
  // root files such as proxy.ts and instrumentation.ts. Web tests are exempt because
  // they start the API in-process against a test database.
  ...restrictBoth(['apps/web/**'], SERVER_ONLY, [SECRET_CONFIG], ['apps/web/test/**']),
  {
    files: [`apps/web/**/*.${TS}`, `apps/web/**/*.${JS}`, `packages/contracts/**/*.${TS}`, `packages/contracts/**/*.${JS}`],
    ignores: ['apps/web/test/**'],
    plugins: { boundaries },
    rules: { 'boundaries/no-server-imports': 'error' },
  },
  ...restrictBoth(['packages/contracts/src/**'], [
    ...SERVER_ONLY,
    { group: ['@pa/config', '@pa/config/*'], message: 'Contracts stay independent of runtime configuration.' },
    { group: ['react', 'react/*', 'next', 'next/*', 'node:*'], message: 'Contracts are shared with the browser; keep them framework- and Node-free.' },
  ]),
  ...restrictBoth(['packages/config/src/**', 'packages/db/src/**'], [
    { group: ['react', 'react/*', 'next', 'next/*'], message: 'Server packages must not import UI frameworks.' },
  ]),
  ...restrictBoth(['apps/worker/src/**'], [
    { group: ['@pa/api', '@pa/api/*'], message: 'The worker reaches the API only through its internal HTTP route.' },
  ]),
  {
    files: [`packages/**/*.${TS}`, `packages/**/*.${JS}`, `apps/**/*.${TS}`, `apps/**/*.${JS}`],
    plugins: { boundaries },
    rules: { 'boundaries/no-evals-imports': 'error' },
  },
  // The v2 structural validators, loader and recipes stay independent of
  // the assessment and of the legacy evaluator: outside their own directory they
  // reach only the frozen v2 table and the batch registry.
  ...restrictBoth(['evals/src/v2/**'], [
    { group: ['@pa/domain', '@pa/domain/*'], message: 'The v2 validators never import the assessment.' },
    { group: ['../*', '!../frozen-v2.js', '!../v2-batches.js'], message: 'The v2 validators import only their own directory, ../frozen-v2.js and ../v2-batches.js.' },
  ]),
  // The data-only batch registry, the one v2 file new data batches extend, imports
  // only hash-only batch tables.
  {
    files: ['evals/src/v2-batches.ts'],
    rules: restrict([{ regex: '^(?!\\./frozen-v2(?:-[a-z0-9-]+)?\\.js$)', message: 'The batch registry imports only ./frozen-v2.js and ./frozen-v2-<name>.js tables.' }]),
  },
  {
    files: [`${DOMAIN_DIRECTORY}/**/*.${TS}`, `${DOMAIN_DIRECTORY}/**/*.${JS}`],
    plugins: { boundaries },
    rules: {
      'boundaries/pure-domain-imports': 'error',
      'boundaries/pure-domain-globals': 'error',
      'no-restricted-globals': [
        'error',
        ...IMPURE_GLOBALS.map((name) => ({ name, message: 'The domain is pure: no clock, timer, network, process or Node global.' })),
        ...CLOCK_GLOBALS.map((name) => ({ name, message: CLOCK_MESSAGE })),
      ],
      'no-restricted-properties': [
        'error',
        ...IMPURE_GLOBALS.map((property) => ({ object: 'globalThis', property, message: 'The domain is pure: no clock, timer, network, process or Node global.' })),
        ...CLOCK_GLOBALS.map((property) => ({ object: 'globalThis', property, message: CLOCK_MESSAGE })),
        { object: 'Math', property: 'random', message: 'The assessment is deterministic.' },
      ],
      // Randomness, time zone and locale members are boundaries/pure-domain-globals.
      'no-restricted-syntax': ['error', { selector: 'MetaProperty[meta.name="import"]', message: 'The domain reads no module URL or environment through import.meta.' }],
    },
  },
]);
