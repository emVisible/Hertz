import { create } from 'zustand'

import type { DownloadTask } from '../api/download'

interface DownloadState {
  tasks: DownloadTask[]
  upsert: (task: DownloadTask) => void
  remove: (id: string) => void
  setAll: (tasks: DownloadTask[]) => void
}

export const useDownloadStore = create<DownloadState>((set) => ({
  tasks: [],
  upsert: (task) =>
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === task.id)
      if (idx === -1) return { tasks: [task, ...s.tasks] }
      const tasks = [...s.tasks]
      tasks[idx] = task
      return { tasks }
    }),
  remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  setAll: (tasks) => set({ tasks }),
}))
