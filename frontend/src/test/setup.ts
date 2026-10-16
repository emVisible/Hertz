// 测试环境：react 19 的 `act` 只在非 production 构建暴露（production 构建物
// 里 `act` 没有导出），否则 @testing-library/react 的 `render` 报
// "React.act is not a function"。测试文件只运行在这里被改写，产品代码无影响。
process.env.NODE_ENV = 'test'

import '@testing-library/jest-dom/vitest'

// React 19 的 CJS 命名空间没有导出 act（act 仅为 ESM 命名导出），
// react-dom-test-utils 的废弃兜底会二次引用 `React.act` 而崩；
// 把 react 导出的 act 挂到模块命名空间上，让 react-dom-test-utils 走
// 正常路径。纯测试环境补丁，产品代码不感知。
import { act as reactAct } from 'react'
const ReactModule = require('react')
if (typeof ReactModule.act !== 'function') {
  ReactModule.act = reactAct
}

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

// jsdom 垫片：CodeMirror 6 在 requestAnimationFrame 里量文字宽度（`measureTextSize`
// → `Range.getClientRects`），jsdom 的 Range 没实现这个 API，于是挂载后第一帧就抛
// uncaught——测试本身还是绿的，整轮 vitest 却以 EXIT=1 结束（很费解的那种失败）。
//
// 只补缺失的方法、不覆盖已有实现；返回空矩形即"量不出宽度"，CM 会退化成按字符数
// 估算，正是测试环境该有的行为。放在这里而不是组件里：产品代码不该知道 jsdom。
if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = function getClientRects() {
      return Object.assign([], { item: () => null }) as unknown as DOMRectList
    }
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect
    }
  }
}
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* jsdom 无布局，不滚动 */
  }
}
