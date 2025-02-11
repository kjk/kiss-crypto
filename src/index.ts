import * as sha256 from 'fast-sha256'
import * as sodium from './libsodium'
import {
  arrayBufferToBase64,
  arrayBufferToHexString,
  arrayBufferToString,
  base64ToArrayBuffer,
  concatUint8Arrays,
  generateRandomKey,
  hexStringToArrayBuffer,
  stringToArrayBuffer,
} from './utils'

export type HexString = string
export type Utf8String = string
export type Base64String = string
export type EncryptedMessage = string
export type EncryptedBlobMessage = Uint8Array

const STRING_PARTITION = ':'

export enum Defaults {
  Version = '001',
  ArgonLength = 32,
  ArgonSaltLength = 16,
  ArgonIterations = 5,
  ArgonMemLimit = 67108864,
  ArgonOutputKeyBytes = 64,
  EncryptionKeyLength = 32,
  EncryptionNonceLength = 24,
}

/**
 * Generates a random key in hex format
 * @returns A string key in hex format
 */
export const generateEncryptionKey = () => {
  return generateRandomKey(Defaults.EncryptionKeyLength)
}

/**
 * Generates a random key in hex format
 * @returns A string key in hex format
 */
export const generateSalt = () => {
  return generateRandomKey(Defaults.ArgonSaltLength)
}

/**
 * Encrypt a message (and associated data) with XChaCha20-Poly1305.
 * @param key - In hex format
 * @param plaintext
 * @returns Base64 ciphertext string
 */
export const encrypt = async ({
  key,
  plaintext,
}: {
  key: HexString
  plaintext: Utf8String
}): Promise<EncryptedMessage> => {
  const nonce = await generateRandomKey(Defaults.EncryptionNonceLength)

  const ciphertext = await xChaChaEncrypt({
    key,
    plaintext,
    nonce,
  })

  return [Defaults.Version, nonce, ciphertext].join(STRING_PARTITION)
}

/**
 * Encrypt a message (and associated data) with XChaCha20-Poly1305.
 * @param key - In hex format
 * @param plainblob - In Uint8Array format
 * @returns Uint8Array ciphertext array
 */
export const encryptBlob = async ({
  key,
  plainblob,
}: {
  key: HexString
  plainblob: Uint8Array
}): Promise<EncryptedBlobMessage> => {
  const nonce = await generateRandomKey(Defaults.EncryptionNonceLength)
  const nonceBuffer = await hexStringToArrayBuffer(nonce)

  const cipherblob = await xChaChaEncryptBlob({
    key,
    plainblob,
    nonceBuffer,
  })

  const versionBuffer = await stringToArrayBuffer(Defaults.Version)

  return concatUint8Arrays(versionBuffer, nonceBuffer, cipherblob)
}

/**
 * Decrypt a message (and associated data) with XChaCha20-Poly1305
 * @param key - In hex format
 * @param ciphertext
 * @returns Plain utf8 string or null if decryption fails
 */
export const decrypt = async ({
  key,
  ciphertext: encryptedMessage,
}: {
  key: HexString
  ciphertext: EncryptedMessage
}): Promise<Utf8String | null> => {
  const [version, nonce, ciphertext] = encryptedMessage.split(STRING_PARTITION, 3)

  if (version < Defaults.Version) {
    throw new Error(`Invalid version: ${version}`)
  }

  return xChaChaDecrypt({key, ciphertext, nonce})
}

/**
 * Decrypt a message (and associated data) with XChaCha20-Poly1305
 * @param key - In hex format
 * @param cipherblob - In Uint8Array format
 * @returns Uint8Array or null if decryption fails
 */
export const decryptBlob = async ({
  key,
  cipherblob: encryptedMessage,
}: {
  key: HexString
  cipherblob: EncryptedBlobMessage
}): Promise<Uint8Array | null> => {
  const versionBuffer = encryptedMessage.slice(0, Defaults.Version.length)
  const version = await arrayBufferToString(versionBuffer)

  if (version < Defaults.Version) {
    throw new Error(`Invalid version: ${version}`)
  }

  const nonceBuffer = encryptedMessage.slice(
    Defaults.Version.length,
    Defaults.Version.length + Defaults.EncryptionNonceLength,
  )

  const cipherblob = encryptedMessage.slice(
    Defaults.Version.length + Defaults.EncryptionNonceLength,
  )

  return xChaChaDecryptBlob({key, cipherblob, nonceBuffer})
}

/**
 * Securely hashes a key with a salt using HKDF-SHA256
 * @param key - Plain text string
 * @param salt - Hex salt string (use generateSalt())
 * @returns Hashed key in hex format
 */
export const hash = async ({
  key,
  salt,
  length = undefined,
}: {
  key: Utf8String
  salt: HexString
  length?: number | undefined
}): Promise<HexString> => {
  const result = sha256.hkdf(
    await stringToArrayBuffer(key),
    await stringToArrayBuffer(salt),
    undefined,
    length,
  )

  return arrayBufferToHexString(result)
}

/**
 * Derives a key from a password and salt using
 * argon2id (crypto_pwhash_ALG_DEFAULT).
 * @param password - Plain text string
 * @param salt - Hex salt string (use generateSalt())
 * @returns Derived key in hex format
 */
export const hashPassword = async ({
  password,
  salt,
  iterations = Defaults.ArgonIterations,
  bytes = Defaults.ArgonMemLimit,
  length = Defaults.ArgonLength,
}: {
  password: Utf8String
  salt: HexString
  iterations?: number
  bytes?: number
  length?: number
}): Promise<HexString> => {
  await sodium.ready

  const result = sodium.crypto_pwhash(
    length,
    await stringToArrayBuffer(password),
    await hexStringToArrayBuffer(salt),
    iterations,
    bytes,
    sodium.crypto_pwhash_ALG_DEFAULT,
    'hex',
  )
  return result
}

// Private functions

const xChaChaEncrypt = async ({
  key,
  plaintext,
  nonce,
}: {
  key: HexString
  plaintext: Utf8String
  nonce: HexString
}): Promise<Base64String> => {
  await sodium.ready

  if (nonce.length !== 48) {
    throw Error('Nonce must be 48 bytes')
  }

  const arrayBuffer = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    await hexStringToArrayBuffer(nonce),
    await hexStringToArrayBuffer(key),
  )

  return arrayBufferToBase64(arrayBuffer)
}

const xChaChaEncryptBlob = async ({
  key,
  plainblob,
  nonceBuffer,
}: {
  key: HexString
  plainblob: Uint8Array
  nonceBuffer: Uint8Array
}): Promise<Uint8Array> => {
  await sodium.ready

  if (nonceBuffer.length !== 24) {
    throw Error('nonceBuffer must be 24 bytes')
  }

  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plainblob,
    null,
    null,
    nonceBuffer,
    await hexStringToArrayBuffer(key),
  )
}

const xChaChaDecrypt = async ({
  key,
  ciphertext,
  nonce,
}: {
  key: HexString
  ciphertext: Base64String
  nonce: HexString
}): Promise<Utf8String | null> => {
  await sodium.ready

  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    await base64ToArrayBuffer(ciphertext),
    null,
    await hexStringToArrayBuffer(nonce),
    await hexStringToArrayBuffer(key),
    'text',
  )
}

const xChaChaDecryptBlob = async ({
  key,
  cipherblob,
  nonceBuffer,
}: {
  key: HexString
  cipherblob: EncryptedBlobMessage
  nonceBuffer: Uint8Array
}): Promise<Uint8Array | null> => {
  await sodium.ready

  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    cipherblob,
    null,
    nonceBuffer,
    await hexStringToArrayBuffer(key),
    'uint8array',
  )
}
