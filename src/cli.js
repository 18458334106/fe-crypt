#!/usr/bin/env node
/**
 * fe-crypt 命令行。
 *
 *   fe-crypt init                 初始化项目（生成 .fecrypt/config.json）
 *   fe-crypt encrypt [路径...]     原地加密（默认 src）
 *   fe-crypt decrypt [路径...]     原地还原为明文
 *   fe-crypt status               查看哪些文件已加密
 *   fe-crypt verify               用当前密钥校验所有密文
 *   fe-crypt snippet              打印 Vite / webpack 接入代码
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  DEFAULT_EXTENSIONS,
  collectFiles,
  configExists,
  createConfig,
  resolveMasterKey,
  statePaths,
  writeConfig,
} from './project.js'
import {
  decryptFiles,
  encryptFiles,
  findEncryptedFiles,
  inspectProject,
  verifyProject,
} from './ops.js'
import { promptHidden } from './prompt.js'

const CLI_VERSION = '1.0.0'

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const c = {
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
}

const HELP = `${c.bold('fe-crypt')} v${CLI_VERSION} — 前端源码（Vue / JS / TS）透明加密

${c.bold('用法')}
  fe-crypt init                    初始化项目（生成 .fecrypt/config.json）
  fe-crypt encrypt [路径...]        原地加密，默认处理 src/
  fe-crypt decrypt [路径...]        原地还原为明文
  fe-crypt status [路径...]         查看加密状态
  fe-crypt verify                  用当前密钥校验全部密文
  fe-crypt snippet                 打印 Vite / webpack 接入配置

${c.bold('选项')}
  --key <密钥>           直接提供密钥（会留在 shell 历史里，建议改用其他方式）
  --key-file <文件>      从文件读取密钥（取第一行非空内容）
  --root <目录>          项目根目录，默认当前目录
  --ext <列表>           额外/自定义扩展名，逗号分隔，如 .js,.ts,.vue
  --exclude <路径>       额外排除的路径，可重复
  --backup <目录>        加密时把明文备份到指定目录（注意：这会削弱加密意义）
  --dry-run              只演练，不落盘
  --all                  decrypt 时还原整个项目中的密文
  --force                init 时覆盖已有配置
  --yes, -y              跳过确认
  --json                 以 JSON 输出结果
  --verbose, -v          输出每个文件的处理结果
  --help, -h             显示帮助
  --version, -V          显示版本

${c.bold('密钥来源优先级')}
  --key > --key-file > 环境变量 FE_CRYPT_KEY > .fecrypt/key > 交互输入

${c.bold('典型流程')}
  fe-crypt init
  fe-crypt encrypt src
  npm run dev        # 构建/开发时插件自动解密，程序照常运行
  fe-crypt decrypt src
`

function parseArgv(argv) {
  const positional = []
  const flags = {}
  const pushFlag = (name, value) => {
    if (name === 'exclude' || name === 'ext') {
      flags[name] = [...(Array.isArray(flags[name]) ? flags[name] : flags[name] ? [flags[name]] : []), value]
    } else {
      flags[name] = value
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        pushFlag(arg.slice(2, eq), arg.slice(eq + 1))
      } else {
        const name = arg.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          pushFlag(name, next)
          i += 1
        } else {
          pushFlag(name, true)
        }
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1 && !path.isAbsolute(arg)) {
      const short = arg.slice(1)
      const map = { y: 'yes', v: 'verbose', h: 'help', V: 'version' }
      if (map[short]) pushFlag(map[short], true)
      else throw new Error(`未知选项：${arg}`)
      continue
    }
    positional.push(arg)
  }
  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags }
}

function resolveRoot(flags) {
  const root = path.resolve(flags.root ?? process.cwd())
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`项目根目录不存在：${root}`)
  }
  return root
}

function extensionList(flags) {
  const raw = flags.ext
  if (!raw) return DEFAULT_EXTENSIONS
  const list = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith('.') ? v : `.${v}`))
  return [...new Set([...DEFAULT_EXTENSIONS, ...list])]
}

function excludeList(flags) {
  const raw = flags.exclude
  if (!raw) return []
  return (Array.isArray(raw) ? raw : [raw]).map(String)
}

async function keyOptions(flags, extra = {}) {
  return {
    key: typeof flags.key === 'string' ? flags.key : undefined,
    keyFile: typeof flags['key-file'] === 'string' ? flags['key-file'] : undefined,
    quiet: Boolean(flags.json),
    ...extra,
  }
}

function printSummary(result, opts = {}) {
  const { encrypted = [], decrypted = [], skipped = [], failed = [], warnings = [] } = result
  const done = encrypted.length || decrypted.length
  for (const item of encrypted) {
    if (opts.verbose) console.log(`  ${c.green('加密')} ${item.file} ${c.dim(`${item.size}B → ${item.encryptedBytes}B`)}`)
  }
  for (const item of decrypted) {
    if (opts.verbose) console.log(`  ${c.cyan('还原')} ${item.file} ${c.dim(`${item.size}B`)}`)
  }
  for (const item of skipped) {
    if (opts.verbose) console.log(`  ${c.dim('跳过')} ${item.file} ${c.dim(item.reason)}`)
  }
  for (const item of failed) {
    console.error(`  ${c.red('失败')} ${item.file} ${c.dim(item.reason)}`)
  }
  for (const item of warnings) {
    console.error(`  ${c.yellow('提醒')} ${item.file} ${c.dim(item.reason)}`)
  }
  const verb = decrypted.length ? '还原' : '加密'
  console.log(
    `${c.bold(done ? c.green(`✔ 完成`) : c.yellow('没有文件被处理'))}  ${verb} ${c.bold(done)} 个，跳过 ${skipped.length}，失败 ${failed.length}`,
  )
}

async function cmdInit(root, flags) {
  if (configExists(root) && !flags.force) {
    throw new Error('项目已初始化（.fecrypt/config.json 已存在）。如需重建请加 --force（会导致旧密文无法解密！）')
  }
  let passphrase = typeof flags.key === 'string' ? flags.key : undefined
  if (!passphrase && process.env.FE_CRYPT_KEY) passphrase = process.env.FE_CRYPT_KEY
  if (!passphrase && typeof flags['key-file'] === 'string') {
    passphrase = fs
      .readFileSync(path.resolve(flags['key-file']), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
  }
  if (!passphrase) {
    if (!process.stdin.isTTY) {
      throw new Error('请通过 --key、--key-file 或环境变量 FE_CRYPT_KEY 提供密钥')
    }
    passphrase = await promptHidden('设置加密密钥: ')
    if (!passphrase) throw new Error('密钥不能为空')
    const again = await promptHidden('再次输入确认: ')
    if (again !== passphrase) throw new Error('两次输入不一致')
  }

  const cfg = createConfig(passphrase)
  writeConfig(root, cfg)
  console.log(`${c.green('✔')} 已初始化：${path.relative(process.cwd(), statePaths(root).config) || statePaths(root).config}`)
  console.log(c.dim('  配置中的项目盐与校验块可以安全提交；密钥本身不要入库。'))
  console.log('')
  console.log('下一步：')
  console.log(`  1) ${c.cyan('fe-crypt encrypt src')}   加密源码`)
  console.log(`  2) 在 vite.config.ts 中加入 ${c.cyan('feCrypt()')} 插件（fe-crypt snippet 可查看）`)
  console.log(`  3) ${c.cyan('npm run dev')} / ${c.cyan('npm run build')} 验证程序可正常运行`)
}

async function cmdEncrypt(root, positional, flags) {
  const targets = positional.length ? positional : ['src']
  const files = await collectFiles(root, targets, {
    extensions: extensionList(flags),
    exclude: excludeList(flags),
  })
  if (files.length === 0) {
    console.log(c.yellow('没有找到可处理的文件。'))
    console.log(c.dim(`  支持扩展名：${extensionList(flags).join(' ')}`))
    return 0
  }

  if (!fs.existsSync(path.join(root, '.git')) && !flags.yes) {
    console.error(
      c.yellow('⚠ 未检测到 git 仓库：加密前请务必备份，或用 --backup 指定备份目录。加 --yes 可跳过此提示。'),
    )
    return 1
  }

  const master = await resolveMasterKey(root, await keyOptions(flags))
  const result = await encryptFiles(root, files, master, {
    dryRun: Boolean(flags['dry-run']),
    backupDir: typeof flags.backup === 'string' ? path.resolve(root, flags.backup) : null,
  })

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    if (flags['dry-run']) console.log(c.dim('（演练模式，未写入任何文件）'))
    printSummary(result, { verbose: flags.verbose })
    if (result.encrypted.length && !flags['dry-run']) {
      console.log(c.dim(`  清单已更新：${path.join('.fecrypt', 'manifest.json')}`))
    }
  }
  return result.failed.length ? 1 : 0
}

async function cmdDecrypt(root, positional, flags) {
  const targets = positional.length ? positional : ['src']
  const files = flags.all
    ? await findEncryptedFiles(root, ['.'], {
        extensions: extensionList(flags),
        exclude: excludeList(flags),
      })
    : await collectFiles(root, targets, {
        extensions: extensionList(flags),
        exclude: excludeList(flags),
      })

  if (files.length === 0) {
    console.log(c.yellow('没有找到文件。'))
    return 0
  }

  const master = await resolveMasterKey(root, await keyOptions(flags))
  const result = await decryptFiles(root, files, master, {
    dryRun: Boolean(flags['dry-run']),
  })

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    if (flags['dry-run']) console.log(c.dim('（演练模式，未写入任何文件）'))
    printSummary(result, { verbose: flags.verbose })
  }
  return result.failed.length ? 1 : 0
}

async function cmdStatus(root, positional, flags) {
  const targets = positional.length ? positional : ['.']
  const { encrypted, plain, orphan } = await inspectProject(root, targets, {
    extensions: extensionList(flags),
    exclude: excludeList(flags),
  })

  if (flags.json) {
    console.log(JSON.stringify({ encrypted, plain, orphan }, null, 2))
    return 0
  }

  console.log(c.bold('加密状态'))
  console.log(`  密文：${c.green(encrypted.length)} 个    明文：${plain.length} 个`)
  if (encrypted.length) {
    console.log('')
    for (const item of encrypted) {
      const mark = item.valid ? c.green('✔') : c.red('✘')
      const extra = [item.recorded ? c.dim('已登记') : c.yellow('未登记')]
      if (!item.valid) extra.push(c.red('封装损坏'))
      console.log(`  ${mark} ${item.file} ${c.dim(`${item.size}B`)} ${extra.join(' ')}`)
    }
  }
  if (orphan.length) {
    console.log('')
    console.log(c.yellow(`  清单中有 ${orphan.length} 个文件已不存在于磁盘：`))
    for (const rel of orphan) console.log(c.dim(`    ${rel}`))
  }
  if (!encrypted.length) {
    console.log(c.dim('\n  还没有加密任何文件。运行 fe-crypt encrypt src'))
  }
  return 0
}

async function cmdVerify(root, flags) {
  const master = await resolveMasterKey(root, await keyOptions(flags))
  const report = await verifyProject(root, master)
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
    return report.corrupt.length || report.mismatch.length || report.missing.length ? 1 : 0
  }
  console.log(c.bold('校验结果'))
  console.log(`  已登记 ${report.checked} 个，通过 ${c.green(report.ok.length)}`)
  for (const item of report.mismatch) console.error(`  ${c.red('不一致')} ${item.file} ${c.dim(item.reason)}`)
  for (const item of report.corrupt) console.error(`  ${c.red('损坏')} ${item.file} ${c.dim(item.reason)}`)
  for (const rel of report.missing) console.error(`  ${c.yellow('缺失')} ${rel}`)
  const bad = report.mismatch.length + report.corrupt.length + report.missing.length
  if (report.checked === 0) console.log(c.dim('  清单为空（没有加密记录）。'))
  return bad ? 1 : 0
}

function cmdSnippet() {
  console.log(c.bold('Vite') + c.dim('  （vite.config.ts / vite.config.js）'))
  console.log(`
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { feCrypt } from 'fe-crypt/vite'

export default defineConfig({
  plugins: [
    feCrypt(),   // 放在 plugins 最前面；内部已声明 enforce: 'pre'
    vue(),
  ],
})
`)
  console.log(c.dim('  密钥通过环境变量 FE_CRYPT_KEY、.fecrypt/key 或插件参数 { key } 提供。'))
  console.log('')
  console.log(c.bold('webpack') + c.dim('  （vue.config.js / webpack.config.js）'))
  console.log(`
module: {
  rules: [
    { test: /\\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|vue)$/, enforce: 'pre', use: ['fe-crypt/webpack'] },
  ],
}
`)
}

async function main() {
  const { command, positional, flags } = parseArgv(process.argv.slice(2))

  if (flags.version || command === '-V' || command === 'version') {
    console.log(CLI_VERSION)
    return 0
  }
  if (flags.help || command === 'help') {
    console.log(HELP)
    return 0
  }

  const root = resolveRoot(flags)

  switch (command) {
    case 'init':
      await cmdInit(root, flags)
      return 0
    case 'encrypt':
      return cmdEncrypt(root, positional, flags)
    case 'decrypt':
      return cmdDecrypt(root, positional, flags)
    case 'status':
      return cmdStatus(root, positional, flags)
    case 'verify':
      return cmdVerify(root, flags)
    case 'snippet':
      cmdSnippet()
      return 0
    default:
      console.error(c.red(`未知命令：${command}`))
      console.log(HELP)
      return 1
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(c.red(`错误：${err.message}`))
    process.exitCode = 1
  })
