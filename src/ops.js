/**
 * 加解密业务：原地加密 / 还原 / 状态 / 校验。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  decryptSource,
  encryptSource,
  looksEncrypted,
  parseEnvelope,
  sha256,
} from './core.js'
import {
  atomicWrite,
  collectFiles,
  readManifest,
  relKey,
  toPosix,
  writeManifest,
} from './project.js'

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** 读出文本，非 UTF-8 / 二进制返回 null */
async function readTextFile(file) {
  const buf = await fsp.readFile(file)
  if (buf.includes(0)) return null
  try {
    const text = utf8.decode(buf)
    return { buf, text }
  } catch {
    return null
  }
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * 原地加密。
 * @returns {Promise<{encrypted: object[], skipped: object[], failed: object[]}>}
 */
export async function encryptFiles(root, files, master, options = {}) {
  const { backupDir = null, dryRun = false, manifest = readManifest(root) } = options
  const result = { encrypted: [], skipped: [], failed: [] }

  for (const file of files) {
    const rel = relKey(root, file)
    try {
      const read = await readTextFile(file)
      if (!read) {
        result.skipped.push({ file: rel, reason: '非 UTF-8 文本或二进制' })
        continue
      }
      if (looksEncrypted(read.text)) {
        if (!parseEnvelope(read.text)) {
          result.failed.push({ file: rel, reason: '疑似密文但封装损坏，请用 git 还原该文件' })
        } else {
          result.skipped.push({ file: rel, reason: '已经是密文' })
        }
        continue
      }
      const envelope = encryptSource(read.buf, master)
      const item = {
        file: rel,
        size: read.buf.length,
        sha256: sha256(read.buf),
        encryptedBytes: Buffer.byteLength(envelope, 'utf8'),
      }
      if (!dryRun) {
        if (backupDir) {
          const target = path.join(backupDir, rel)
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.writeFile(target, read.buf)
        }
        await atomicWrite(file, `${envelope}\n`)
        manifest.files[rel] = {
          sha256: item.sha256,
          size: item.size,
          encryptedAt: nowIso(),
          envelopeSha256: sha256(envelope),
        }
      }
      result.encrypted.push(item)
    } catch (err) {
      result.failed.push({ file: rel, reason: err.message })
    }
  }

  if (!dryRun && result.encrypted.length > 0) writeManifest(root, manifest)
  return result
}

/**
 * 原地还原为明文。
 * @returns {Promise<{decrypted: object[], skipped: object[], failed: object[], warnings: object[]}>}
 */
export async function decryptFiles(root, files, master, options = {}) {
  const { dryRun = false, manifest = readManifest(root) } = options
  const result = { decrypted: [], skipped: [], failed: [], warnings: [] }

  for (const file of files) {
    const rel = relKey(root, file)
    try {
      const text = await fsp.readFile(file, 'utf8')
      if (!looksEncrypted(text)) {
        result.skipped.push({ file: rel, reason: '不是密文' })
        continue
      }
      const plain = decryptSource(text, master)
      const digest = sha256(plain)
      const known = manifest.files[rel]
      if (known && known.sha256 && known.sha256 !== digest) {
        result.warnings.push({
          file: rel,
          reason: '解密内容与清单记录不一致（清单可能过期），已按密文实际内容还原',
        })
      }
      if (!dryRun) {
        await atomicWrite(file, plain)
        delete manifest.files[rel]
      }
      result.decrypted.push({ file: rel, size: plain.length, sha256: digest })
    } catch (err) {
      result.failed.push({ file: rel, reason: err.message })
    }
  }

  if (!dryRun && result.decrypted.length > 0) writeManifest(root, manifest)
  return result
}

/** 扫描项目，统计明文 / 密文 */
export async function inspectProject(root, targets, options = {}) {
  const files = await collectFiles(root, targets.length ? targets : ['.'], options)
  const manifest = readManifest(root)
  const encrypted = []
  const plain = []
  const orphan = []

  for (const file of files) {
    const rel = relKey(root, file)
    const read = await readTextFile(file)
    if (!read) continue
    if (looksEncrypted(read.text)) {
      const ok = Boolean(parseEnvelope(read.text))
      encrypted.push({
        file: rel,
        size: (await fsp.stat(file)).size,
        valid: ok,
        recorded: Boolean(manifest.files[rel]),
      })
    } else {
      plain.push({ file: rel, size: read.buf.length })
    }
  }

  const present = new Set(encrypted.map((e) => e.file))
  for (const rel of Object.keys(manifest.files)) {
    if (!present.has(rel)) orphan.push(rel)
  }
  return { encrypted, plain, orphan }
}

/** 校验：所有登记文件都能用当前密钥解开，且与记录哈希一致 */
export async function verifyProject(root, master, options = {}) {
  const manifest = readManifest(root)
  const entries = Object.entries(manifest.files)
  const report = { checked: 0, ok: [], mismatch: [], missing: [], corrupt: [] }

  for (const [rel, meta] of entries) {
    const file = path.join(root, rel)
    report.checked += 1
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      report.missing.push(rel)
      continue
    }
    if (!looksEncrypted(text)) {
      report.mismatch.push({ file: rel, reason: '文件已不是密文' })
      continue
    }
    try {
      const plain = decryptSource(text, master)
      const digest = sha256(plain)
      if (meta.sha256 && digest !== meta.sha256) {
        report.mismatch.push({ file: rel, reason: '哈希与清单不一致' })
      } else {
        report.ok.push(rel)
      }
    } catch (err) {
      report.corrupt.push({ file: rel, reason: err.message })
    }
  }
  return report
}

/** 找到当前工作区里所有密文（用于 decrypt --all） */
export async function findEncryptedFiles(root, targets = ['.'], options = {}) {
  const files = await collectFiles(root, targets.length ? targets : ['.'], options)
  const out = []
  for (const file of files) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '')
    if (looksEncrypted(text)) out.push(file)
  }
  return out
}

export { toPosix }
