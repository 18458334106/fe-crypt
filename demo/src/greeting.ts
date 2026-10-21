export function describe(algo: string): string {
  const parts = ['构建时自动解密', algo, '每文件独立密钥']
  return parts.join(' · ')
}
