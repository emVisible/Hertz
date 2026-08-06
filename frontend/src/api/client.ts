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
}

export function fileUrl(path: string): string {
  return `${API_BASE}/api/library/file?path=${encodeURIComponent(path)}`
}

export function thumbnailUrl(path: string): string {
  return `${API_BASE}/api/library/thumbnail?path=${encodeURIComponent(path)}`
}
