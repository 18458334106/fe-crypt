/**
 * Vite 插件：在其它插件读取源码之前，把 fe-crypt 密文透明解密。
 *
 * 用法：
 *   import { feCrypt } from 'fe-crypt/vite'
 *   plugins: [feCrypt(), vue()]
 *
 * 密钥优先级：插件参数 key > keyFile > 环境变量 FE_CRYPT_KEY > .fecrypt/key
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { decryptSource, deriveMasterKey, looksEncrypted, verifyKeyCheck } from './core.js'
import {
  DEFAULT_EXTENSIONS,
  isSupportedFile,
  readConfig,
  readKeyFile,
  statePaths,
  toPosix,
} from './project.js'

const PLUGIN_NAME = 'fe-crypt'

export function feCrypt(options = {}) {
  const {
    key,
    keyFile,
    envName = 'FE_CRYPT_KEY',
    root: rootOption,
    extensions = DEFAULT_EXTENSIONS,
    silent = false,
  } = options

  let root = rootOption ? path.resolve(rootOption) : process.cwd()
  let master = null
  let warned = false

  const log = (msg) => {
    if (!silent) console.log(`[${PLUGIN_NAME}] ${msg}`)
  }

  async function getMaster() {
    if (master) return master
    const cfg = readConfig(root)
    let passphrase = key
    let source = '插件参数 key'
    if (!passphrase && keyFile) {
      passphrase = readKeyFile(path.resolve(root, keyFile))
      source = `keyFile: ${keyFile}`
    }
    if (!passphrase && process.env[envName]) {
      passphrase = process.env[envName]
      source = `环境变量 ${envName}`
    }
    if (!passphrase) {
      const localKey = statePaths(root).key
      if (await exists(localKey)) {
        passphrase = readKeyFile(localKey)
        source = '.fecrypt/key'
      }
    }
    if (!passphrase) {
      throw new Error(
        `检测到加密文件，但没有可用的密钥。\n` +
          `  请设置环境变量 ${envName}，或创建 .fecrypt/key，或给插件传入 { key }。\n` +
          `  项目根目录：${root}`,
      )
    }
    const salt = Buffer.from(cfg.kdf.salt, 'base64')
    const candidate = deriveMasterKey(passphrase, salt, cfg.kdf)
    if (cfg.check && !verifyKeyCheck(cfg.check, candidate)) {
      throw new Error(`密钥不正确（来源：${source}）`)
    }
    master = candidate
    if (!silent) log(`密钥已加载（来源：${source}），加密源码将在内存中解密`)
    return master
  }

  return {
    name: PLUGIN_NAME,
    enforce: 'pre',

    configResolved(config) {
      root = rootOption ? path.resolve(rootOption) : config.root
    },

    async load(id) {
      if (!id) return null
      // 只处理真实文件；跳过虚拟模块和 URL
      if (id.startsWith('\0') || /^[a-zA-Z]+:\/\//.test(id)) return null

      const qIndex = id.indexOf('?')
      const cleanId = qIndex === -1 ? id : id.slice(0, qIndex)
      const query = qIndex === -1 ? '' : id.slice(qIndex + 1)
      if (query) {
        // 放行 Vite 的缓存击穿参数（HMR 的 ?t=、依赖的 ?v=），
        // 其余 query（?vue&type=script、?raw、?url…）交给后续插件处理
        const allowed = new Set(['t', 'v'])
        const keys = [...new URLSearchParams(query).keys()]
        if (keys.length === 0 || !keys.every((k) => allowed.has(k))) return null
      }

      const file = path.isAbsolute(cleanId) ? cleanId : path.resolve(root, cleanId)
      if (!isSupportedFile(file, extensions)) return null

      let code
      try {
        code = await fsp.readFile(file, 'utf8')
      } catch {
        return null
      }
      if (!looksEncrypted(code)) {
        if (!warned && code.includes('FECRYPT:v1:')) {
          warned = true
          this.warn(`文件 ${toPosix(path.relative(root, file))} 含 FECRYPT 标记但格式不完整`)
        }
        return null
      }

      const m = await getMaster()
      const plain = decryptSource(code, m)
      return { code: plain.toString('utf8'), map: null }
    },
  }
}

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export default feCrypt
