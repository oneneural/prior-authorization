/** Result of resolving an RFC 6901 JSON Pointer against a parsed JSON value. */
export type PointerResolution = { found: true; value: unknown } | { found: false };

/** Resolves a pointer without coercion; array indices must be canonical decimal integers. */
export function resolvePointer(document: unknown, pointer: string): PointerResolution {
  if (pointer === '') {
    return { found: true, value: document };
  }
  if (!pointer.startsWith('/')) {
    return { found: false };
  }
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length) {
        return { found: false };
      }
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
