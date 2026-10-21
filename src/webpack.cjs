/**
 * webpack loader（webpack 4/5、vue-cli、Vite? 不适用）。
 *
 * 用法（vue.config.js）：
 *   chainWebpack: (config) => {
 *     config.module.rule('fe-crypt').test(/\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|vue)$/).enforce('pre')
 *       .use('fe-crypt').loader('fe-crypt/webpack')
 *   }
 *
 * 该文件是 CommonJS，内部通过动态 import() 复用 ESM 核心，避免双份实现。
 */
'use strict'

const path = require('node:path')

module.exports = function feCryptLoader(source) {
  const callback = this.async()
  const file = this.resourcePath
  const rootContext = this.rootContext || process.cwd()
  const options = typeof this.getOptions === 'function' ? this.getOptions() || {} : {}

  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source)

  import('./core.js')
    .then(async ({ looksEncrypted, decryptSource }) => {
      if (!looksEncrypted(text)) return callback(null, source)

      const { readConfig, readKeyFile, statePaths } = await import('./project.js')
      const { deriveMasterKey, verifyKeyCheck } = await import('./core.js')
      const root = options.root ? path.resolve(rootContext, options.root) : rootContext
      const cfg = readConfig(root)

      let passphrase = options.key
      if (!passphrase && options.keyFile) {
        passphrase = readKeyFile(path.resolve(root, options.keyFile))
      }
      if (!passphrase && process.env[options.envName || 'FE_CRYPT_KEY']) {
        passphrase = process.env[options.envName || 'FE_CRYPT_KEY']
      }
      if (!passphrase) {
        try {
          passphrase = readKeyFile(statePaths(root).key)
        } catch {
          /* 交给下面统一报错 */
        }
      }
      if (!passphrase) {
        throw new Error(
          'fe-crypt: 检测到加密文件但没有密钥。请设置 FE_CRYPT_KEY、创建 .fecrypt/key，或给 loader 传 { key }',
        )
      }

      const master = deriveMasterKey(passphrase, Buffer.from(cfg.kdf.salt, 'base64'), cfg.kdf)
      if (cfg.check && !verifyKeyCheck(cfg.check, master)) {
        throw new Error('fe-crypt: 密钥不正确')
      }
      callback(null, decryptSource(text, master).toString('utf8'))
    })
    .catch((err) => callback(err))
}

module.exports.raw = false
