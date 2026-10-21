import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { feCrypt } from '../src/vite.js'

// feCrypt 必须排在插件列表里；内部 enforce: 'pre'，会在 vue 插件编译之前
// 把被加密的 .vue / .ts 在内存中解密。
export default defineConfig({
  plugins: [feCrypt(), vue()],
})
