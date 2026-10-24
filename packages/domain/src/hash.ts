/** Computes the lower-case hexadecimal SHA-256 digest of exact bytes. */
export type Sha256Hasher = (bytes: Uint8Array) => Promise<string>;

/** SHA-256 through the Web Crypto global, available in Node and browsers alike. */
export const webCryptoSha256: Sha256Hasher = async (bytes) => {
  // A copy is backed by an ArrayBuffer, as the Web Crypto BufferSource type requires.
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
