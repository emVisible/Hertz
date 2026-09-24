/** 本地模型状态卡的判定（v0.32 S4 浏览器实测后抽出）。

 浏览器里抓到的形状：状态查询还没回来（或 404）时，卡片直接把 `!data?.deps` 当结论，
 于是两张卡都在指责「依赖未安装（请重新 uv sync）」——一个「我还没问到」的状态被
 说成「我查过并且坏了」。用户照着提示去跑 uv sync，依赖本来就没事。

 所以把「问到没 / 报错没 / 依赖在不在 / 就绪没」做成显式枚举：徽标文案与配色都由
 这一个函数决定，组件只负责渲染。
 */

import type { BadgeTone } from '../components/ui/Badge'

export type ModelState = 'checking' | 'unavailable' | 'noDeps' | 'ready' | 'missing'

export function modelState(q: {
  loaded: boolean
  error: boolean
  deps?: boolean
  ready?: boolean
}): ModelState {
  if (!q.loaded) return q.error ? 'unavailable' : 'checking'
  if (!q.deps) return 'noDeps'
  return q.ready ? 'ready' : 'missing'
}

const TONES: Record<ModelState, BadgeTone> = {
  checking: 'neutral',
  unavailable: 'warning',
  noDeps: 'error',
  ready: 'success',
  missing: 'warning',
}

export function modelStateTone(state: ModelState): BadgeTone {
  return TONES[state]
}
