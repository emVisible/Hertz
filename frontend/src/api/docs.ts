/** Docs domain: project-level markdown documents (read / create / edit / delete). */

import { api } from './client'

export interface DocContent {
  path: string
  content: string
}

export const docsApi = {
  list: () => api.get<{ files: string[] }>('/api/docs').then((r) => r.files),
  content: (path: string) => api.get<DocContent>(`/api/docs/content?path=${encodeURIComponent(path)}`),
  save: (path: string, content: string) => api.post<{ path: string }>('/api/docs/save', { path, content }),
  remove: (path: string) => api.delete(`/api/docs?path=${encodeURIComponent(path)}`),
}
