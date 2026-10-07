// Algorithm names: the canonical spelling of every name the crypto rules can report, the
// parts of a JCA transformation or an OpenSSL style cipher name, and the weakness policy.
import { looksSecret, quotableLiteral } from "../util.js";

// Canonical names keyed by their lower case spelling without spaces. The JCA standard names
// are the canonical form; other libraries' spellings map onto them.
const NAMES = {};
const name = (canonical, ...aliases) => {
  for (const alias of [canonical, ...aliases]) {
    NAMES[alias.toLowerCase().replace(/\s+/g, "")] = canonical;
  }
};

// Message digests
name("MD2");
name("MD4");
name("MD5");
name("SHA-1", "SHA1", "SHA", "SHA-0");
name("SHA-224", "SHA224");
name("SHA-256", "SHA256");
name("SHA-384", "SHA384");
name("SHA-512", "SHA512");
name("SHA-512/224", "SHA512/224", "SHA512-224", "SHA-512-224");
name("SHA-512/256", "SHA512/256", "SHA512-256", "SHA-512-256");
name("SHA3-224", "SHA3_224", "SHA-3-224");
name("SHA3-256", "SHA3_256", "SHA-3-256");
name("SHA3-384", "SHA3_384", "SHA-3-384");
name("SHA3-512", "SHA3_512", "SHA-3-512");
name("SHAKE128");
name("SHAKE256");
name("RIPEMD160", "RIPEMD-160", "RMD160");
name("BLAKE2b-512", "BLAKE2B512", "BLAKE2B-512");
name("BLAKE2s-256", "BLAKE2S256", "BLAKE2S-256");
name("Whirlpool");
name("SM3");
// MACs
name("HmacMD5", "HMAC-MD5");
name("HmacSHA1", "HMAC-SHA1");
name("HmacSHA224", "HMAC-SHA224");
name("HmacSHA256", "HMAC-SHA256");
name("HmacSHA384", "HMAC-SHA384");
name("HmacSHA512", "HMAC-SHA512");
name("HmacSHA3-256", "HMAC-SHA3-256");
name("HmacSHA3-512", "HMAC-SHA3-512");
name("HMAC");
name("CMAC", "AESCMAC");
name("Poly1305");
// Symmetric ciphers
name("AES", "AES_128", "AES_192", "AES_256", "AES-128", "AES-192", "AES-256");
name("DES");
name("DESede", "TripleDES", "3DES", "DES-EDE3", "DES-EDE", "TDEA");
name("RC2");
name("RC4", "ARCFOUR", "ARC4");
name("Blowfish", "BF");
name("Camellia");
name("ChaCha20");
name("ChaCha20-Poly1305", "CHACHA20POLY1305");
name("AES-GCM");
name("AES-CBC");
name("AES-CTR");
name("AES-KW");
name("SM4");
// Public key and key agreement
name("RSA");
name("RSA-OAEP");
name("RSASSA-PSS", "RSA-PSS");
name("RSASSA-PKCS1-v1_5");
name("DSA");
name("EC", "ECDSA-KEY");
name("ECDSA");
name("ECDH");
name("ECIES");
name("DH", "DiffieHellman");
name("XDH");
name("X25519");
name("X448");
name("Ed25519");
name("Ed448");
name("EdDSA");
// Signatures
for (const hash of [
  "MD2",
  "MD5",
  "SHA1",
  "SHA224",
  "SHA256",
  "SHA384",
  "SHA512"
]) {
  name(`${hash}withRSA`);
  name(`${hash}withDSA`);
  name(`${hash}withECDSA`);
}
name("SHA256withRSA/PSS", "SHA256WITHRSAANDMGF1");
name("SHA3-256withECDSA", "SHA3-256WITHECDSA");
name("NONEwithRSA");
name("NONEwithECDSA");
// Key derivation and password hashing
name("PBKDF2WithHmacSHA1", "PBKDF2");
name("PBKDF2WithHmacSHA256");
name("PBKDF2WithHmacSHA384");
name("PBKDF2WithHmacSHA512");
name("PBEWithMD5AndDES");
name("PBEWithMD5AndTripleDES");
name("PBEWithSHA1AndDESede");
name("PBEWithSHA1AndRC4_128");
name("PBEWithHmacSHA256AndAES_128");
name("PBEWithHmacSHA256AndAES_256");
name("HKDF");
name("scrypt", "SCRYPT");
name("bcrypt", "BCRYPT");
name("Argon2", "ARGON2");
name("Argon2id", "ARGON2ID", "ARGON2_ID");
name("Argon2i", "ARGON2I", "ARGON2_I");
name("Argon2d", "ARGON2D", "ARGON2_D");
// JSON Web Algorithms
for (const size of ["256", "384", "512"]) {
  name(`HS${size}`);
  name(`RS${size}`);
  name(`ES${size}`);
  name(`PS${size}`);
}
name("none");
// Random generators
name("DRBG", "HASH_DRBG", "HMAC_DRBG", "CTR_DRBG");
name("SHA1PRNG");
name("NativePRNG");
name("Windows-PRNG");
// Protocols and key stores
name("TLS");
name("TLSv1");
name("TLSv1.1");
name("TLSv1.2");
name("TLSv1.3");
name("DTLSv1.2");
name("SSL");
name("SSLv3");
name("JKS");
name("JCEKS");
name("PKCS12");
name("BCFKS");

/** Every canonical name the rules can report. */
export const CANONICAL_ALGORITHMS = Object.freeze(
  [...new Set(Object.values(NAMES))].sort()
);

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/_.+-]{0,63}$/;

/**
 * A value the report may carry as an algorithm name: quotable, not shaped like a secret, and
 * shaped like a name. Anything else stays out of the report.
 *
 * @param {*} value Resolved value
 * @returns {string|undefined}
 */
export function algorithmText(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!NAME_SHAPE.test(text) || !quotableLiteral(text) || looksSecret(text)) {
    return undefined;
  }
  return text;
}

/** The canonical spelling of an algorithm name, or the name itself when it is not known. */
export function canonicalName(text) {
  return NAMES[String(text).toLowerCase().replace(/\s+/g, "")] || text;
}

const MODES = [
  "ECB",
  "CBC",
  "CTR",
  "GCM",
  "CCM",
  "CFB",
  "OFB",
  "XTS",
  "KW",
  "SIV"
];

/**
 * The algorithm, mode, padding and key size a transformation names: a JCA transformation
 * (`AES/GCM/NoPadding`) or an OpenSSL style cipher name (`aes-256-gcm`, `des-ede3-cbc`).
 *
 * @param {string} text Transformation as written
 * @returns {{algorithm: string, mode?: string, padding?: string, keySize?: number}}
 */
export function parseTransformation(text) {
  if (text.includes("/")) {
    const [algorithm, mode, padding] = text.split("/");
    const sized = /^AES_(\d+)$/i.exec(algorithm);
    return {
      algorithm: canonicalName(algorithm),
      ...(mode && mode.toUpperCase() !== "NONE"
        ? { mode: mode.toUpperCase() }
        : {}),
      ...(padding ? { padding } : {}),
      ...(sized ? { keySize: Number(sized[1]) } : {})
    };
  }
  const known = NAMES[text.toLowerCase()];
  if (known) {
    return { algorithm: known };
  }
  // OpenSSL style: <cipher>[-<bits>][-<mode>]
  const pieces = text.toLowerCase().split("-");
  const last = pieces[pieces.length - 1].toUpperCase();
  const mode = MODES.includes(last) ? last : undefined;
  const body = mode ? pieces.slice(0, -1) : pieces;
  const bits = /^\d+$/.test(body[body.length - 1] || "")
    ? Number(body[body.length - 1])
    : undefined;
  const base = bits !== undefined ? body.slice(0, -1) : body;
  const algorithm = NAMES[base.join("-")] || NAMES[base.join("")];
  if (!algorithm) {
    return { algorithm: canonicalName(text) };
  }
  return {
    algorithm,
    ...(mode ? { mode } : {}),
    ...(bits !== undefined && algorithm !== "DESede" ? { keySize: bits } : {})
  };
}

/** The primitive a cipher transformation is, refined from the API's own primitive. */
export function cipherPrimitive(parts, fallback) {
  if (["RSA", "ECIES", "RSA-OAEP"].includes(parts.algorithm)) {
    return "pke";
  }
  if (
    parts.algorithm === "ChaCha20-Poly1305" ||
    parts.algorithm === "AES-GCM" ||
    ["GCM", "CCM", "SIV"].includes(parts.mode)
  ) {
    return "ae";
  }
  if (["RC4", "ChaCha20"].includes(parts.algorithm)) {
    return "stream-cipher";
  }
  return fallback;
}

const WEAK_HASHES = new Set(["MD2", "MD4", "MD5", "SHA-1"]);
const WEAK_CIPHERS = new Set(["DES", "DESede", "RC2", "RC4", "Blowfish"]);
const WEAK_PROTOCOLS = new Set(["SSL", "SSLv3", "TLSv1", "TLSv1.1"]);
const BLOCK_CIPHERS = new Set([
  "AES",
  "DES",
  "DESede",
  "RC2",
  "Blowfish",
  "Camellia",
  "SM4"
]);
const KEY_SIZE_FLOOR = { RSA: 2048, DSA: 2048, DH: 2048 };
const WEAK_CURVES =
  /^(secp1[0-9]{2}[rk]1|prime1[0-9]{2}v[1-3]|sect1[0-9]{2}[rk][12]|brainpoolP1[0-9]{2}[rt]1)$/i;

/**
 * True when a finding uses a broken or too short primitive: MD5 and MD4 anywhere, SHA-1 as a
 * plain digest or in a signature (HMAC and PBKDF2 over SHA-1 are not broken), the legacy
 * ciphers, ECB for a block cipher, the old protocols, short RSA, DSA and DH keys and small
 * curves.
 *
 * @param {Object} finding Crypto finding
 * @returns {boolean}
 */
export function isWeak(finding) {
  const algorithm = finding.algorithm;
  if (!algorithm) {
    return false;
  }
  if (WEAK_HASHES.has(algorithm) || WEAK_CIPHERS.has(algorithm)) {
    return true;
  }
  if (WEAK_PROTOCOLS.has(algorithm) || algorithm === "none") {
    return true;
  }
  if (/^(MD2|MD5|SHA1)with/i.test(algorithm) || /MD5/i.test(algorithm)) {
    return true;
  }
  if (/^PBEWith/i.test(algorithm) && /DES|RC4|RC2/i.test(algorithm)) {
    return true;
  }
  if (finding.mode === "ECB" && BLOCK_CIPHERS.has(algorithm)) {
    return true;
  }
  const floor = KEY_SIZE_FLOOR[algorithm];
  if (floor && finding.keySize !== undefined && finding.keySize < floor) {
    return true;
  }
  if (finding.curve && WEAK_CURVES.test(finding.curve)) {
    return true;
  }
  return false;
}
