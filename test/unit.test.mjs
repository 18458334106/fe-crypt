import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_KDF,
  PREFIX,
  deriveMasterKey,
  decryptSource,
  encryptSource,
  looksEncrypted,
  parseEnvelope,
} from '../src/core.js'
import { createConfig } from '../src/project.js'
import { feCrypt } from '../src/vite.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'src', 'cli.js')
const KEY = 'test-key-正确-123'

function tmpdir(prefix = 'fe-crypt-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function master() {
  const cfg = createConfig(KEY)
  return deriveMasterKey(KEY, Buffer.from(cfg.kdf.salt, 'base64'), cfg.kdf)
}

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FE_CRYPT_KEY: KEY, NO_COLOR: '1', ...env },
  })
}

test('encrypt/decrypt 逐字节还原（含 CRLF、BOM、无结尾换行）', () => {
  const m = master()
  const samples = [
    Buffer.from(''),
    Buffer.from('const a = 1\n'),
    Buffer.from('const a = 1\r\nconst b = 2\r\n'),
    Buffer.from('\uFEFF<template><div>中文</div></template>'),
    Buffer.from('no-trailing-newline'),
    Buffer.from('emoji 🚀🔐 与 \u0000 之外的控制字符 \t\n'),
  ]
  for (const sample of samples) {
    const enc = encryptSource(sample, m)
    assert.ok(looksEncrypted(enc))
    assert.equal(enc.split('\n').length, 1, '密文必须是单行')
    const dec = decryptSource(enc, m)
    assert.deepEqual(dec, sample)
  }
})

test('随机数据往返（1MB）', () => {
  const m = master()
  const buf = Buffer.from(Array.from({ length: 1024 * 1024 }, () => Math.floor(Math.random() * 256)))
  assert.deepEqual(decryptSource(encryptSource(buf, m), m), buf)
})

test('密钥错误会失败并给出明确错误', () => {
  const m = master()
  const enc = encryptSource('secret', m)
  const wrong = deriveMasterKey('other-key', Buffer.from(createConfig('x').kdf.salt, 'base64'), DEFAULT_KDF)
  assert.throws(() => decryptSource(enc, wrong), /密钥不正确|解密失败/)
})

test('密文被篡改会被 GCM 认证拒绝', () => {
  const m = master()
  const enc = encryptSource('const value = 42\n', m)
  const body = enc.slice(PREFIX.length, -2)
  const flipped = (body[10] === 'A' ? 'B' : 'A') + body.slice(1)
  const tampered = `${PREFIX}${flipped}*/`
  assert.throws(() => decryptSource(tampered, m), /损坏|解密失败/)
})

test('封装解析：非法内容返回 null 或抛错', () => {
  assert.equal(parseEnvelope('const a = 1'), null)
  assert.equal(parseEnvelope('/* not fe-crypt */'), null)
  assert.throws(() => parseEnvelope('/*FECRYPT:v1:AAAA*/'), /长度不足/)
  assert.equal(looksEncrypted('// normal code'), false)
})

test('Vite 插件 load 钩子透明解密 .vue / .ts', async () => {
  const root = tmpdir()
  const cfg = createConfig(KEY)
  fs.mkdirSync(path.join(root, '.fecrypt'), { recursive: true })
  fs.writeFileSync(path.join(root, '.fecrypt', 'config.json'), JSON.stringify(cfg))
  const m = deriveMasterKey(KEY, Buffer.from(cfg.kdf.salt, 'base64'), cfg.kdf)

  const vueSource = `<template>\n  <div>{{ msg }}</div>\n</template>\n<script setup lang="ts">\nconst msg: string = '你好'\n</script>\n`
  const tsSource = `export const answer: number = 42\n`
  const vueFile = path.join(root, 'App.vue')
  const tsFile = path.join(root, 'main.ts')
  fs.writeFileSync(vueFile, `${encryptSource(vueSource, m)}\n`)
  fs.writeFileSync(tsFile, `${encryptSource(tsSource, m)}\n`)

  const plugin = feCrypt({ root, key: KEY, silent: true })
  plugin.configResolved({ root })
  const loadedVue = await plugin.load.call({ warn() {} }, vueFile)
  const loadedTs = await plugin.load.call({ warn() {} }, tsFile)
  assert.equal(loadedVue.code, vueSource)
  assert.equal(loadedTs.code, tsSource)

  // HMR 会带 ?t=<timestamp>，必须继续解密（回归测试）
  const loadedHot = await plugin.load.call({ warn() {} }, `${vueFile}?t=1700000000000`)
  assert.equal(loadedHot.code, vueSource)
  // SFC 子请求交给 plugin-vue
  assert.equal(
    await plugin.load.call({ warn() {} }, `${vueFile}?vue&type=script&setup=true&lang.ts`),
    null,
  )

  // 明文文件原样返回 null（交给其它插件）
  fs.writeFileSync(path.join(root, 'plain.ts'), 'export const x = 1\n')
  assert.equal(await plugin.load.call({ warn() {} }, path.join(root, 'plain.ts')), null)

  // 没有密钥时报错
  const noKey = feCrypt({ root, key: undefined, silent: true })
  noKey.configResolved({ root })
  delete process.env.FE_CRYPT_KEY
  await assert.rejects(() => noKey.load.call({ warn() {} }, vueFile), /没有可用的密钥/)
})

test('CLI: init → encrypt → status → decrypt 全流程', async () => {
  const root = tmpdir()
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  const original = `<template><h1>Hello</h1></template>\n<script setup>\nimport { ref } from 'vue'\nconst n = ref(0)\n</script>\n`
  const app = path.join(root, 'src', 'App.vue')
  fs.writeFileSync(app, original)
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export const add = (a: number, b: number) => a + b\n')
  fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}\n')
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'types.d.ts'), 'declare const x: number\n')

  let r = runCli(root, ['init'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(fs.existsSync(path.join(root, '.fecrypt', 'config.json')))

  r = runCli(root, ['encrypt', 'src', '--yes'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const encryptedVue = fs.readFileSync(app, 'utf8')
  assert.ok(encryptedVue.startsWith(PREFIX), 'vue 文件应变为密文')
  assert.equal(fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8'), 'export default {}\n', '配置文件不能被加密')
  assert.equal(fs.readFileSync(path.join(root, 'src', 'types.d.ts'), 'utf8'), 'declare const x: number\n', '.d.ts 默认跳过')
  assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'utf8'), 'module.exports = 1\n')

  r = runCli(root, ['status', 'src'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /密文：2/)

  r = runCli(root, ['verify'])
  assert.equal(r.status, 0, r.stderr + r.stdout)

  r = runCli(root, ['decrypt', 'src'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(fs.readFileSync(app, 'utf8'), original, '必须逐字节还原')
  assert.equal(fs.readFileSync(path.join(root, 'src', 'util.ts'), 'utf8'), 'export const add = (a: number, b: number) => a + b\n')

  // 重复加密应跳过
  r = runCli(root, ['encrypt', 'src', '--yes'])
  assert.equal(r.status, 0)
  r = runCli(root, ['encrypt', 'src', '--yes'])
  assert.match(r.stdout, /跳过 2/)
})

test('CLI: 错误密钥被拒绝，且不会破坏文件', async () => {
  const root = tmpdir()
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  const file = path.join(root, 'src', 'a.js')
  fs.writeFileSync(file, 'export const a = 1\n')
  runCli(root, ['init'])
  runCli(root, ['encrypt', 'src', '--yes'])
  const before = fs.readFileSync(file)

  const r = runCli(root, ['verify'], { FE_CRYPT_KEY: 'wrong-key' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /密钥不正确/)

  const r2 = runCli(root, ['decrypt', 'src'], { FE_CRYPT_KEY: 'wrong-key' })
  assert.equal(r2.status, 1)
  assert.deepEqual(fs.readFileSync(file), before, '解密失败时文件必须保持原样')
})

test('CLI: --dry-run 不写盘', async () => {
  const root = tmpdir()
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  const file = path.join(root, 'src', 'a.js')
  fs.writeFileSync(file, 'export const a = 1\n')
  runCli(root, ['init'])
  const r = runCli(root, ['encrypt', 'src', '--yes', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const a = 1\n')
})

test('collectFiles 跳过 dist / .d.ts / 配置文件', async () => {
  const { collectFiles } = await import('../src/project.js')
  const root = tmpdir()
  for (const [rel, body] of Object.entries({
    'src/a.ts': 'export {}\n',
    'src/b.vue': '<template/>\n',
    'src/c.d.ts': 'declare const c: 1\n',
    'dist/bundle.js': 'var x\n',
    'vite.config.ts': 'export default {}\n',
    'src/nested/deep/d.jsx': 'export default () => null\n',
  })) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  const files = await collectFiles(root, ['src', 'vite.config.ts', 'dist'])
  const rels = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort()
  assert.deepEqual(rels, ['src/a.ts', 'src/b.vue', 'src/nested/deep/d.jsx'])
})
