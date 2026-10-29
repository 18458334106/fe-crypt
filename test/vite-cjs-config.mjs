/**
 * 回归测试：vite.config.js 是 CommonJS 时，`require('fe-crypt/vite')` 必须可用。
 *
 * 背景：本包是纯 ESM。当项目没有 `"type": "module"`（或配置名为 .cjs）时，Vite 会把
 * 配置打包成 CJS，并把裸模块 externalize，运行时再 require —— 纯 ESM 包会直接报
 *   "fe-crypt/vite" resolved to an ESM file. ESM file cannot be loaded by `require`.
 * 这里用真实的 Vite build API 走一遍“CJS 配置 → require 插件 → 解密源码 → 构建”，
 * 确保 exports 的 require 条件（src/vite.cjs）始终有效。
 *
 * 需要一份 Vite 安装，按以下顺序查找：
 *   1. 环境变量 FE_CRYPT_VITE_PATH 指向 vite 包目录（含 package.json）
 *   2. demo/node_modules/vite（先 cd demo && npm install）
 *
 * 用法：
 *   node test/vite-cjs-config.mjs
 *   $env:FE_CRYPT_VITE_PATH='D:\proj\node_modules\vite'; node test/vite-cjs-config.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConfig } from '../src/project.js'
import { deriveMasterKey, encryptSource } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')
const KEY = 'cjs-config-test-key'
const MARKER = 'CJS_CONFIG_OK'

function fail(message) {
  console.error(`✘ ${message}`)
  process.exitCode = 1
}

function findVite() {
  const candidates = [process.env.FE_CRYPT_VITE_PATH, path.join(repoRoot, 'demo', 'node_modules', 'vite')]
  for (const dir of candidates) {
    if (!dir) continue
    const pkg = path.join(dir, 'package.json')
    if (!fs.existsSync(pkg)) continue
    try {
      if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'vite') return dir
    } catch {
      /* 忽略损坏的候选目录 */
    }
  }
  return null
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function link(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

async function main() {
  const viteDir = findVite()
  if (!viteDir) {
    fail('找不到 Vite。请先 cd demo && npm install，或设置 FE_CRYPT_VITE_PATH 指向 vite 包目录。')
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-crypt-cjs-'))
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'fe-crypt-cjs-fixture', private: true, version: '1.0.0' }, null, 2)}\n`,
    )
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html>\n<html><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n',
    )
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })

    // 加密源码 + 项目配置
    const cfg = createConfig(KEY)
    fs.mkdirSync(path.join(root, '.fecrypt'), { recursive: true })
    fs.writeFileSync(path.join(root, '.fecrypt', 'config.json'), JSON.stringify(cfg, null, 2))
    const master = deriveMasterKey(KEY, Buffer.from(cfg.kdf.salt, 'base64'), cfg.kdf)
    const plain = `document.querySelector('#app').textContent = '${MARKER}'\n`
    fs.writeFileSync(path.join(root, 'src', 'main.js'), `${encryptSource(plain, master)}\n`)

    // 关键：CommonJS 配置，没有 "type": "module"
    fs.writeFileSync(
      path.join(root, 'vite.config.js'),
      [
        "const { feCrypt } = require('fe-crypt/vite')",
        'module.exports = { plugins: [feCrypt({ silent: true })] }',
        '',
      ].join('\n'),
    )

    link(repoRoot, path.join(root, 'node_modules', 'fe-crypt'))
    link(viteDir, path.join(root, 'node_modules', 'vite'))

    process.env.FE_CRYPT_KEY = KEY
    const vite = await import(pathToFileURL(path.join(viteDir, 'dist', 'node', 'index.js')).href)
    await vite.build({
      root,
      configFile: path.join(root, 'vite.config.js'),
      logLevel: 'warn',
      build: { minify: false },
    })

    const outputs = walk(path.join(root, 'dist'))
    const bundle = outputs.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8'))
    if (bundle.length === 0) {
      fail('构建产物里没有 JS 文件')
      return
    }
    if (!bundle.some((code) => code.includes(MARKER))) {
      fail('产物中没有解密后的源码，CJS 插件未生效')
      return
    }
    if (bundle.some((code) => code.includes('FECRYPT'))) {
      fail('产物中残留 FECRYPT 密文标记')
      return
    }
    console.log('✔ CommonJS vite.config.js 下 require("fe-crypt/vite") 构建成功，源码已透明解密')
  } finally {
    process.env.FE_CRYPT_KEY = undefined
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
