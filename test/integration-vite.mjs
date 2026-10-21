/**
 * 端到端验证：
 *   1. 真实 Vue3 + Vite 项目加密前构建 → 记录 dist 指纹
 *   2. 原地加密 src → 再次构建 → dist 必须与加密前逐字节一致
 *   3. 启动 vite dev → 页面与解密后的模块正常返回
 *   4. 解密还原 → 源码与加密前逐字节一致
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', 'demo')
const cli = path.join(here, '..', 'src', 'cli.js')
const KEY = 'demo-passphrase-please-change'
const PORT = 5188
const env = { ...process.env, FE_CRYPT_KEY: KEY, NO_COLOR: '1' }

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function walk(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out[path.relative(base, full).split(path.sep).join('/')] = hash(fs.readFileSync(full))
  }
  return out
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

function build(label) {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true })
  const r = run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr)
    throw new Error(`${label} 构建失败`)
  }
  return walk(path.join(root, 'dist'))
}

function diffMaps(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const diffs = []
  for (const k of keys) if (a[k] !== b[k]) diffs.push(k)
  return diffs
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  if (!fs.existsSync(path.join(root, 'node_modules', 'vite'))) {
    throw new Error('请先在 demo 目录执行 npm install')
  }

  // 干净起点
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.fecrypt'), { recursive: true, force: true })

  const sourceFiles = ['src/App.vue', 'src/main.ts', 'src/greeting.ts', 'index.html', 'vite.config.js']
  const beforeSources = Object.fromEntries(
    sourceFiles.map((rel) => [rel, hash(fs.readFileSync(path.join(root, rel)))]),
  )

  console.log('\n== 1. 加密前构建 ==')
  const baseDist = build('加密前')
  check('构建产物包含 JS/CSS', Object.keys(baseDist).some((f) => f.endsWith('.js')))

  console.log('\n== 2. 原地加密源码 ==')
  let r = run(process.execPath, [cli, 'init'], { cwd: root })
  check('fe-crypt init', r.status === 0, (r.stderr || '').trim())
  r = run(process.execPath, [cli, 'encrypt', 'src', '--yes'], { cwd: root })
  check('fe-crypt encrypt src', r.status === 0, (r.stdout || '').trim().split('\n').pop())
  const encApp = fs.readFileSync(path.join(root, 'src', 'App.vue'), 'utf8')
  check('App.vue 已变成密文', encApp.startsWith('/*FECRYPT:v1:'))
  check('App.vue 只剩一行', encApp.trim().split('\n').length === 1)
  check('vite.config.js 未被加密', !fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8').includes('FECRYPT'))

  console.log('\n== 3. 加密后重新构建（应完全一致）==')
  const encDist = build('加密后')
  const diffs = diffMaps(baseDist, encDist)
  check('dist 文件集合与内容完全一致', diffs.length === 0, diffs.join(', '))
  const bundle = Object.entries(encDist).filter(([f]) => f.endsWith('.js'))
  check('产物中不含 FECRYPT 标记', !bundle.some(([f]) => fs.readFileSync(path.join(root, 'dist', f), 'utf8').includes('FECRYPT')))
  check(
    '产物中保留了解密后的业务代码',
    Object.keys(encDist)
      .filter((f) => f.endsWith('.js'))
      .some((f) => fs.readFileSync(path.join(root, 'dist', f), 'utf8').includes('源码已加密')),
  )

  console.log('\n== 4. dev server（源码仍是密文）==')
  const dev = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  )
  let devLog = ''
  dev.stdout.on('data', (d) => (devLog += d))
  dev.stderr.on('data', (d) => (devLog += d))

  try {
    const ready = await waitForServer(`http://127.0.0.1:${PORT}/`)
    check('dev server 启动', ready, ready ? '' : devLog.slice(-400))

    if (ready) {
      const page = await fetch(`http://127.0.0.1:${PORT}/`)
      check('首页 200', page.status === 200)
      const html = await page.text()
      check('首页包含 #app 挂载点', html.includes('id="app"'))

      const appModule = await fetch(`http://127.0.0.1:${PORT}/src/App.vue`)
      const appCode = await appModule.text()
      check('App.vue 模块 200', appModule.status === 200, String(appModule.status))
      check('dev 下模块已解密（含模板内容）', appCode.includes('源码已加密'))
      check('dev 下模块不含 FECRYPT 标记', !appCode.includes('FECRYPT'))

      const mainModule = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`)
      const mainCode = await mainModule.text()
      check('main.ts 模块 200', mainModule.status === 200, String(mainModule.status))
      check('dev 下 main.ts 已解密', mainCode.includes('createApp'))

      // HMR / 缓存击穿参数（?t=）是最容易踩坑的路径
      const hotModule = await fetch(`http://127.0.0.1:${PORT}/src/App.vue?t=1700000000000`)
      const hotCode = await hotModule.text()
      check('带 ?t= 的模块请求 200', hotModule.status === 200, String(hotModule.status))
      check('带 ?t= 时仍能解密', hotCode.includes('源码已加密'))
    }
  } finally {
    killTree(dev.pid)
  }

  console.log('\n== 5. 解密还原 ==')
  r = run(process.execPath, [cli, 'decrypt', 'src'], { cwd: root })
  check('fe-crypt decrypt src', r.status === 0, (r.stderr || '').trim())
  const afterSources = Object.fromEntries(
    sourceFiles.map((rel) => [rel, hash(fs.readFileSync(path.join(root, rel)))]),
  )
  const sourceDiffs = sourceFiles.filter((f) => beforeSources[f] !== afterSources[f])
  check('源码逐字节还原', sourceDiffs.length === 0, sourceDiffs.join(', '))

  r = run(process.execPath, [cli, 'status', 'src'])
  check('status 显示已无密文', /密文：0/.test(r.stdout), (r.stdout || '').trim())

  // 清理，保持 demo 目录干净
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true })
  fs.rmSync(path.join(root, '.fecrypt'), { recursive: true, force: true })

  console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
