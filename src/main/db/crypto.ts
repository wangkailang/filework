import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { app, safeStorage } from "electron";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const FIXED_SALT = "filework-llm-config-salt-v1";
const KEYCHAIN_PREFIX = "keychain:v1:";

let derivedKey: Buffer | null = null;

function getKey(): Buffer {
  if (!derivedKey) {
    const seed = app.getPath("userData");
    derivedKey = pbkdf2Sync(
      seed,
      FIXED_SALT,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      "sha256",
    );
  }
  return derivedKey;
}

/**
 * 使用 AES-256-GCM 加密明文字符串。
 * @returns "iv:authTag:ciphertext" 格式的加密字符串(十六进制编码)。
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext}`;
}

/**
 * 解密先前由 `encrypt` 加密的字符串。
 * @param encrypted "iv:authTag:ciphertext" 格式的字符串。
 * @returns 原始明文。
 */
export function decrypt(encrypted: string): string {
  const key = getKey();
  const [ivHex, authTagHex, ciphertext] = encrypted.split(":");

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");

  return plaintext;
}

export function isKeychainEncryptionAvailable(): boolean {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

export function isKeychainEncryptedValue(encrypted: string): boolean {
  return encrypted.startsWith(KEYCHAIN_PREFIX);
}

export function encryptWithKeychain(plaintext: string): string {
  if (!isKeychainEncryptionAvailable()) {
    throw new Error("Keychain encryption is not available");
  }
  const encrypted = safeStorage.encryptString(plaintext);
  return `${KEYCHAIN_PREFIX}${encrypted.toString("base64")}`;
}

export function decryptWithKeychain(encrypted: string): string {
  if (!isKeychainEncryptedValue(encrypted)) {
    throw new Error("Value is not keychain-encrypted");
  }
  if (!isKeychainEncryptionAvailable()) {
    throw new Error("Keychain encryption is not available");
  }
  const encoded = encrypted.slice(KEYCHAIN_PREFIX.length);
  return safeStorage.decryptString(Buffer.from(encoded, "base64"));
}
