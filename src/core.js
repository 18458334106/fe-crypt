/**
 * fe-crypt 核心：封装格式 + 密钥派生 + AES-256-GCM 加解密。
 *
 * 文件封装格式（单行、纯 ASCII、可安全放在源码文件里）：
 *   以块注释包裹：FECRYPT:v1:<base64url(salt16 | iv12 | ciphertext | tag16)>
 *   整行只有这一个注释，前后可以有空白，解密后逐字节还原原始文件。
 *
 * - 主密钥 = scrypt(口令, 项目盐)，每个项目只算一次（约 50~100ms）。
 * - 文件密钥 = HKDF-SHA256(主密钥, 每文件随机盐)，保证每文件独立。
 * - 密文使用 GCM 认证，密钥错误 / 文件被篡改都会解密失败，不会产出错误代码。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

export const MAGIC = 'FECRYPT'
export const VERSION = 1
export const PREFIX = `/*${MAGIC}:v${VERSION}:`
export const SUFFIX = '*/'
export const AAD = Buffer.from(`${MAGIC}:v${VERSION}`, 'utf8')

export const SALT_BYTES = 16
export const IV_BYTES = 12
export const TAG_BYTES = 16

/** 默认 scrypt 参数：N=2^15, r=8, p=1（约 32MiB 内存，单次约 50~100ms） */
export const DEFAULT_KDF = Object.freeze({
  name: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 32,
  saltBytes: SALT_BYTES,
})

/** 用于校验口令是否正确的固定明文（只存在本地 config 里） */
export const KEY_CHECK_PLAINTEXT = 'fe-crypt:key-check:v1'

const STRICT_ENVELOPE_RE = /^\/\*FECRYPT:v1:([A-Za-z0-9_-]+)\*\/$/

function maxmemFor(kdf) {
  // scrypt 需要 128*N*r 字节，额外留 32MiB 余量
  return 128 * kdf.N * kdf.r + 128 * kdf.r * kdf.p + 32 * 1024 * 1024
}

/**
 * 由口令 + 项目盐派生主密钥。
 * @param {string|Buffer} passphrase
 * @param {Buffer} salt
 * @param {typeof DEFAULT_KDF} [kdf]
 * @returns {Buffer} 32 字节主密钥
 */
export function deriveMasterKey(passphrase, salt, kdf = DEFAULT_KDF) {
  if (typeof passphrase !== 'string' && !Buffer.isBuffer(passphrase)) {
    throw new TypeError('密钥必须是字符串')
  }
  if (!Buffer.isBuffer(salt) || salt.length < 8) {
    throw new TypeError('项目盐无效')
  }
  if (!passphrase || passphrase.length === 0) {
    throw new Error('密钥不能为空')
  }
  return scryptSync(passphrase, salt, kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: maxmemFor(kdf),
  })
}

/** 每个文件独立子密钥：HKDF-SHA256(master, fileSalt) */
export function deriveFileKey(master, fileSalt) {
  const out = hkdfSync('sha256', master, fileSalt, `${MAGIC}:v${VERSION}:file`, 32)
  return Buffer.from(out)
}

/** 是否是 fe-crypt 密文（前缀匹配，宽松） */
export function looksEncrypted(text) {
  return typeof text === 'string' && text.trimStart().startsWith(PREFIX)
}

/** 严格解析：返回 { salt, iv, ciphertext, tag } 或 null */
export function parseEnvelope(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  const m = STRICT_ENVELOPE_RE.exec(trimmed)
  if (!m) return null
  const raw = Buffer.from(m[1], 'base64url')
  const min = SALT_BYTES + IV_BYTES + TAG_BYTES
  if (raw.length < min) {
    throw new Error('密文格式损坏：负载长度不足')
  }
  return {
    salt: raw.subarray(0, SALT_BYTES),
    iv: raw.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES),
    ciphertext: raw.subarray(SALT_BYTES + IV_BYTES, raw.length - TAG_BYTES),
    tag: raw.subarray(raw.length - TAG_BYTES),
  }
}

/**
 * 加密任意字节内容，返回单行封装字符串。
 * @param {Buffer|string} plaintext
 * @param {Buffer} master 32 字节主密钥
 * @returns {string}
 */
export function encryptSource(plaintext, master) {
  if (!Buffer.isBuffer(master) || master.length !== 32) {
    throw new TypeError('主密钥必须是 32 字节 Buffer')
  }
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveFileKey(master, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([salt, iv, ciphertext, tag])
  return `${PREFIX}${payload.toString('base64url')}${SUFFIX}`
}

/**
 * 解密封装文本，返回原始字节（与加密前逐字节一致）。
 * @param {string} text
 * @param {Buffer} master
 * @returns {Buffer}
 */
export function decryptSource(text, master) {
  if (!Buffer.isBuffer(master) || master.length !== 32) {
    throw new TypeError('主密钥必须是 32 字节 Buffer')
  }
  if (!looksEncrypted(text)) {
    throw new Error('不是 fe-crypt 加密文件')
  }
  const parts = parseEnvelope(text)
  if (!parts) {
    throw new Error('密文格式损坏：封装头无法解析')
  }
  const key = deriveFileKey(master, parts.salt)
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv)
  decipher.setAAD(AAD)
  decipher.setAuthTag(parts.tag)
  try {
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()])
  } catch {
    throw new Error('解密失败：密钥不正确，或文件已被篡改')
  }
}

/** 判断两个 Buffer 是否相等（常量时间，防时序侧信道） */
export function safeEqual(a, b) {
  try {
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 生成密钥校验块（用于提前发现错误口令） */
export function makeKeyCheck(master) {
  return encryptSource(KEY_CHECK_PLAINTEXT, master)
}

/** 校验口令是否正确，返回 boolean */
export function verifyKeyCheck(checkEnvelope, master) {
  try {
    const plain = decryptSource(checkEnvelope, master)
    return plain.toString('utf8') === KEY_CHECK_PLAINTEXT
  } catch {
    return false
  }
}
