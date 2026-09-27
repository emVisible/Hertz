/** Typed API client for the Hertz backend. */

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit, raw = false): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    let detail = resp.statusText
    try {
      const body = await resp.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* keep statusText */
    }
    throw new ApiError(resp.status, detail)
  }
  return (raw ? resp.text() : resp.json()) as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  getText: <T = string>(path: string) => request<T>(path, undefined, true),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** multipart 上传（文件/音色包等）：FormData，不设 JSON 头 */
  postForm: async <T>(path: string, form: FormData, params?: Record<string, string>): Promise<T> => {
    const q = params ? `?${new URLSearchParams(params).toString()}` : ''
    const resp = await fetch(`${API_BASE}${path}${q}`, { method: 'POST', body: form })
    if (!resp.ok) {
      let detail = resp.statusText
      try {
        const body = await resp.json()
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
      } catch {
        /* keep statusText */
      }
      throw new ApiError(resp.status, detail)
    }
    return resp.json() as Promise<T>
  },
}

/** 媒体 URL（v0.8.9 缓存版本）：v 追加为查询参数——反复制作覆盖同名文件
 *  （final.mp4/cover.jpg）时浏览器按 URL 缓存旧内容，传 item.updated_at 强制失效。 */
export function fileUrl(path: string, v?: string | number | null): string {
  const base = `${API_BASE}/api/library/file?path=${encodeURIComponent(path)}`
  return v ? `${base}&v=${encodeURIComponent(String(v))}` : base
}

export function thumbnailUrl(path: string, v?: string | number | null): string {
  const base = `${API_BASE}/api/library/thumbnail?path=${encodeURIComponent(path)}`
  return v ? `${base}&v=${encodeURIComponent(String(v))}` : base
}
