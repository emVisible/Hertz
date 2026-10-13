/** api/layout.ts 的 mock 层契约测试：端点路径、方法、payload 与查询参数编码。
 *
 * layout 域是 MD Studio 唯一的持久化通道——路径或 body 形状错了不会报类型错，
 * 只会 404/422，所以这里逐个端点钉死。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ method: string; path: string; body?: unknown }> = []

vi.mock('./client', () => ({
  api: {
    get: (path: string) => {
      calls.push({ method: 'GET', path })
      return Promise.resolve([])
    },
    post: (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body })
      return Promise.resolve({ id: 'new-id' })
    },
    put: (path: string, body?: unknown) => {
      calls.push({ method: 'PUT', path, body })
      return Promise.resolve({ id: 'x' })
    },
    delete: (path: string) => {
      calls.push({ method: 'DELETE', path })
      return Promise.resolve({ ok: true })
    },
  },
  ApiError: class ApiError extends Error {},
}))

import { layoutApi } from './layout'

beforeEach(() => {
  calls.length = 0
})

describe('layoutApi 端点契约', () => {
  it('list：GET /api/layout', async () => {
    await layoutApi.list()
    expect(calls).toEqual([{ method: 'GET', path: '/api/layout' }])
  })

  it('create：POST 全稿字段原样进 body', async () => {
    const body = {
      title: '新品发布稿',
      source_md: '# 标题',
      source_ref: 'notes/a.md',
      platform: 'wechat' as const,
      theme_id: 'modi',
      overrides: { color: '#ff0000' },
      cover: {},
    }
    await layoutApi.create(body)
    expect(calls).toEqual([{ method: 'POST', path: '/api/layout', body }])
  })

  it('get / update / remove：/{id} 三件套', async () => {
    await layoutApi.get('abc')
    await layoutApi.update('abc', { title: '改名', theme_id: 'wanfeng' })
    await layoutApi.remove('abc')
    expect(calls).toEqual([
      { method: 'GET', path: '/api/layout/abc' },
      { method: 'PUT', path: '/api/layout/abc', body: { title: '改名', theme_id: 'wanfeng' } },
      { method: 'DELETE', path: '/api/layout/abc' },
    ])
  })

  it('importDocs：path 走查询参数且编码（中文/空格/斜杠）', async () => {
    await layoutApi.importDocs('专栏/第 1 期.md')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].path).toBe(`/api/layout/import/docs?path=${encodeURIComponent('专栏/第 1 期.md')}`)
  })

  it('importStudio：run slug 走查询参数且编码', async () => {
    await layoutApi.importStudio('run 2026-10-13')
    expect(calls[0].path).toBe(`/api/layout/import/studio?run=${encodeURIComponent('run 2026-10-13')}`)
  })
})
