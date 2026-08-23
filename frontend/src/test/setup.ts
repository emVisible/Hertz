import '@testing-library/jest-dom/vitest'

// Node ≥22 的实验性内置 localStorage（未给 --localstorage-file 时恒为 undefined）
// 会遮蔽 jsdom 的实现——zustand persist 拿到 undefined 存储，任何 setState 即崩。
// 仅在缺失时注入内存版 Web Storage shim（Node 26 + jsdom 30 实测被遮蔽）。
if (typeof localStorage === 'undefined') {
  const mem = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return mem.size
    },
    clear: () => mem.clear(),
    getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
    key: (i) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k) => void mem.delete(k),
    setItem: (k, v) => void mem.set(k, String(v)),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  })
}
