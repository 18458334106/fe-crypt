/**
 * 项目状态：.fecrypt/config.json、密钥来源、文件遍历、清单（manifest）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DEFAULT_KDF, deriveMasterKey, makeKeyCheck, verifyKeyCheck } from './core.js'
import { promptHidden } from './prompt.js'

export const STATE_DIR = '.fecrypt'
export const CONFIG_FILE = 'config.json'
export const MANIFEST_FILE = 'manifest.json'
export const KEY_FILE = 'key'

/** 默认可加密扩展名 */
export const DEFAULT_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.vue',
])

/** 永远不加密的文件名 / 模式（配置类文件必须在 Vite 加载插件前就是明文） */
const DENY_BASENAMES = [
  /^(vite|vitest|webpack|rollup|esbuild|postcss|tailwind|uno|nuxt|astro|svelte|babel|tsup|unocss)\.config\.[cm]?[jt]s$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^package(-lock)?\.json$/i,
  /^\.env(\..+)?$/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^index\.html$/i,
]

/** 默认忽略的目录 */
const DENY_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.output',
  '.nuxt',
  '.next',
  '.svelte-kit',
  'coverage',
  '.fecrypt',
  '.vite',
  '.cache',
  '.turbo',
  '.idea',
  '.vscode',
])

export function isSupportedFile(file, extensions = DEFAULT_EXTENSIONS) {
  const base = path.basename(file)
  if (base.endsWith('.d.ts')) return false
  if (DENY_BASENAMES.some((re) => re.test(base))) return false
  return extensions.includes(path.extname(base).toLowerCase())
}

export function isDeniedDir(name) {
  return DENY_DIRS.has(name)
}

export function statePaths(root) {
  const dir = path.join(root, STATE_DIR)
  return {
    dir,
    config: path.join(dir, CONFIG_FILE),
    manifest: path.join(dir, MANIFEST_FILE),
    key: path.join(dir, KEY_FILE),
  }
}

export function configExists(root) {
  return fs.existsSync(statePaths(root).config)
}

export function readConfig(root) {
  const p = statePaths(root).config
  if (!fs.existsSync(p)) {
    throw new Error(`未找到 ${STATE_DIR}/${CONFIG_FILE}，请先在项目根目录运行 "fe-crypt init"`)
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!cfg || cfg.version !== 1 || !cfg.kdf || !cfg.kdf.salt) {
    throw new Error(`${STATE_DIR}/${CONFIG_FILE} 内容无效（version/kdf.salt 缺失）`)
  }
  return cfg
}

export function writeConfig(root, cfg) {
  const { dir, config } = statePaths(root)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(config, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  const gitignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, `# 密钥文件绝不入库\n${KEY_FILE}\n`, 'utf8')
  }
}

/** 新建项目配置：生成项目盐 + 口令校验块 */
export function createConfig(passphrase) {
  const salt = randomBytes(DEFAULT_KDF.saltBytes)
  const kdf = { ...DEFAULT_KDF, salt: salt.toString('base64') }
  const master = deriveMasterKey(passphrase, salt, kdf)
  return {
    version: 1,
    cipher: 'aes-256-gcm',
    kdf,
    check: makeKeyCheck(master),
    createdAt: new Date().toISOString(),
  }
}

/**
 * 解析主密钥。优先级：显式 key > keyFile > 环境变量 FE_CRYPT_KEY > .fecrypt/key > 交互输入
 * @returns {Promise<Buffer>}
 */
export async function resolveMasterKey(root, options = {}) {
  const {
    key,
    keyFile,
    envName = 'FE_CRYPT_KEY',
    prompt = '请输入加密密钥: ',
    allowPrompt = process.stdin.isTTY,
    quiet = false,
  } = options

  let passphrase = key
  let source = '参数 --key'

  if (!passphrase && keyFile) {
    passphrase = readKeyFile(keyFile)
    source = `密钥文件 ${keyFile}`
  }
  if (!passphrase && process.env[envName]) {
    passphrase = process.env[envName]
    source = `环境变量 ${envName}`
  }
  if (!passphrase && fs.existsSync(statePaths(root).key)) {
    passphrase = readKeyFile(statePaths(root).key)
    source = `${STATE_DIR}/${KEY_FILE}`
  }
  if (!passphrase) {
    if (!allowPrompt) {
      throw new Error(
        '没有可用的密钥：请使用 --key、--key-file、环境变量 FE_CRYPT_KEY，或写入 .fecrypt/key',
      )
    }
    passphrase = await promptHidden(prompt)
    source = '手动输入'
  }
  if (!passphrase) throw new Error('密钥不能为空')

  const cfg = readConfig(root)
  const salt = Buffer.from(cfg.kdf.salt, 'base64')
  const master = deriveMasterKey(passphrase, salt, cfg.kdf)
  if (cfg.check && !verifyKeyCheck(cfg.check, master)) {
    throw new Error(`密钥不正确（来源：${source}）`)
  }
  if (!quiet) process.stderr.write(`· 密钥来源：${source}\n`)
  return master
}

export function readKeyFile(file) {
  const p = path.resolve(file)
  if (!fs.existsSync(p)) throw new Error(`密钥文件不存在：${p}`)
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  const value = firstLine.trim()
  if (!value) throw new Error(`密钥文件为空：${p}`)
  return value
}

/** 读取清单；不存在时返回空结构 */
export function readManifest(root) {
  const p = statePaths(root).manifest
  if (!fs.existsSync(p)) return { version: 1, files: {} }
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!m || typeof m !== 'object' || typeof m.files !== 'object' || !m.files) {
      return { version: 1, files: {} }
    }
    return { version: 1, ...m, files: m.files }
  } catch {
    return { version: 1, files: {} }
  }
}

export function writeManifest(root, manifest) {
  const { dir, manifest: p } = statePaths(root)
  fs.mkdirSync(dir, { recursive: true })
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    files: sortObject(manifest.files),
  }
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, p)
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
}

export function toPosix(p) {
  return p.split(path.sep).join('/')
}

export function relKey(root, file) {
  return toPosix(path.relative(root, file))
}

export function assertInsideRoot(root, file) {
  const rel = path.relative(root, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`文件不在项目根目录内：${file}`)
  }
}

/**
 * 递归收集待处理文件。
 * @param {string} root
 * @param {string[]} targets 相对/绝对路径
 * @param {{extensions?: string[], exclude?: string[]}} [opts]
 * @returns {Promise<string[]>} 绝对路径，已排序
 */
export async function collectFiles(root, targets, opts = {}) {
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS
  const extraExclude = (opts.exclude ?? []).map((p) => path.resolve(root, p))
  const out = new Set()

  const walk = async (dir) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (extraExclude.some((ex) => full === ex || full.startsWith(`${ex}${path.sep}`))) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (isDeniedDir(entry.name)) continue
        await walk(full)
      } else if (entry.isFile() && isSupportedFile(full, extensions)) {
        out.add(full)
      }
    }
  }

  for (const target of targets) {
    const full = path.resolve(root, target)
    assertInsideRoot(root, full)
    let st
    try {
      st = await fsp.stat(full)
    } catch {
      throw new Error(`路径不存在：${target}`)
    }
    if (st.isDirectory()) {
      if (isDeniedDir(path.basename(full))) continue
      await walk(full)
    } else if (st.isFile() && isSupportedFile(full, extensions)) {
      out.add(full)
    }
  }
  return [...out].sort()
}

/** 原子写入：先写临时文件再改名，保留原文件权限 */
export async function atomicWrite(file, data) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const st = await fsp.stat(file).catch(() => null)
  await fsp.writeFile(tmp, data)
  if (st) await fsp.chmod(tmp, st.mode).catch(() => {})
  await fsp.rename(tmp, file)
}
