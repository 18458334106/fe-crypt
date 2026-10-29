/**
 * Vite 插件的 CommonJS 入口，供 `require('fe-crypt/vite')` 使用。
 *
 * 为什么需要它：本包是纯 ESM（package.json `"type": "module"`）。当项目里的
 * vite.config.js 是 CommonJS（没有 `"type": "module"`，或文件名以 .cjs 结尾）时，
 * Vite 打包配置会用 esbuild 输出 CJS，并把裸模块（bare import）标记为 external，
 * 运行时再 `require('fe-crypt/vite')`。此时编辑器/构建器会直接报：
 *
 *   "fe-crypt/vite" resolved to an ESM file. ESM file cannot be loaded by `require`.
 *
 * 这里提供一个 CommonJS 外壳：工厂函数本身是同步的，内部用动态 import() 复用
 * 同一份 ESM 实现（src/vite.js），因此不会出现两套逻辑、也不会重复计算密钥。
 * `package.json` 的 exports 已按 import / require 分流，ESM 项目仍然加载 src/vite.js。
 *
 * 用法（vite.config.js，CommonJS）：
 *   const { feCrypt } = require('fe-crypt/vite')
 *   module.exports = { plugins: [feCrypt()] }
 *
 * 注意：钩子必须写成 async —— Vite 会 await 每个钩子，延迟加载对调用方透明。
 */
'use strict'

const PLUGIN_NAME = 'fe-crypt'

/**
 * @param {object} [options] 与 ESM 入口完全一致：key / keyFile / envName / root / extensions / silent
 * @returns {import('vite').Plugin}
 */
function feCrypt(options = {}) {
  const instance = import('./vite.js').then((mod) => mod.feCrypt(options))

  return {
    name: PLUGIN_NAME,
    enforce: 'pre',

    async configResolved(config) {
      const plugin = await instance
      if (typeof plugin.configResolved === 'function') {
        await plugin.configResolved.call(this, config)
      }
    },

    async load(id) {
      const plugin = await instance
      return typeof plugin.load === 'function' ? plugin.load.call(this, id) : null
    },
  }
}

module.exports = feCrypt
module.exports.feCrypt = feCrypt
module.exports.default = feCrypt
