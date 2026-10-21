/**
 * 隐藏输入的密钥读取（Windows / macOS / Linux 终端均可用）。
 * 只读取字符，不回显，不进入 shell history。
 */
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const stdout = process.stdout

    if (!stdin.isTTY) {
      reject(
        new Error(
          '当前不是交互式终端，无法安全读取密钥。请使用 --key、--key-file 或环境变量 FE_CRYPT_KEY',
        ),
      )
      return
    }

    stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''

    const cleanup = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
    }

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          // Ctrl+C
          cleanup()
          process.exit(130)
        }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          cleanup()
          resolve(value)
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        if (ch === '\u001b') {
          // 忽略方向键等转义序列
          continue
        }
        if (ch >= ' ') {
          value += ch
          stdout.write('*')
        }
      }
    }

    stdin.on('data', onData)
  })
}
