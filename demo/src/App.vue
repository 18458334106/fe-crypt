<template>
  <main class="page">
    <section class="card">
      <p class="tag">fe-crypt demo</p>
      <h1>{{ title }}</h1>
      <p class="desc">{{ desc }}</p>
      <button class="btn" type="button" @click="count += 1">
        点击次数 <span class="num">{{ count }}</span>
      </button>
      <p class="hint">这一页由被加密的 .vue / .ts 源码构建而成，构建产物与加密前完全一致。</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { describe } from './greeting'

const title = '源码已加密，程序照常运行'
const desc = describe('AES-256-GCM')
const count = ref(0)
</script>

<style scoped>
.page {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  background:
    radial-gradient(1200px 600px at 10% -10%, #dbeafe 0%, transparent 60%),
    radial-gradient(900px 500px at 100% 0%, #ede9fe 0%, transparent 55%),
    #f8fafc;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #0f172a;
}

.card {
  width: min(560px, calc(100vw - 48px));
  padding: 40px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 24px 60px -24px rgba(15, 23, 42, 0.35);
  backdrop-filter: blur(12px);
}

.tag {
  margin: 0 0 12px;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #6366f1;
}

h1 {
  margin: 0 0 12px;
  font-size: 30px;
  line-height: 1.25;
}

.desc {
  margin: 0 0 28px;
  color: #475569;
  line-height: 1.7;
}

.btn {
  appearance: none;
  border: 0;
  border-radius: 999px;
  padding: 12px 22px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  box-shadow: 0 12px 24px -12px rgba(99, 102, 241, 0.9);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 18px 30px -14px rgba(99, 102, 241, 0.9);
}

.btn:active {
  transform: translateY(0);
}

.num {
  display: inline-block;
  min-width: 1.4em;
  margin-left: 6px;
  padding: 0 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
}

.hint {
  margin: 24px 0 0;
  font-size: 13px;
  color: #64748b;
}
</style>
