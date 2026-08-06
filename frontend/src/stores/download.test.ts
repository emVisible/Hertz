import { beforeEach, describe, expect, it } from 'vitest'

import { useDownloadStore } from './download'

const TASK = {
  id: 't1',
  url: 'https://example.com/a.mp4',
  provider: 'generic',
  status: 'pending' as const,
  progress: 0,
  total_bytes: null,
  downloaded_bytes: 0,
  file_path: null,
  error: null,
  created_at: null,
  metadata: {},
}

describe('download store', () => {
  beforeEach(() => {
    useDownloadStore.setState({ tasks: [] })
  })

  it('upserts new tasks at the front', () => {
    useDownloadStore.getState().upsert(TASK)
    useDownloadStore.getState().upsert({ ...TASK, id: 't2' })
    expect(useDownloadStore.getState().tasks.map((t) => t.id)).toEqual(['t2', 't1'])
  })

  it('upsert updates an existing task in place', () => {
    useDownloadStore.getState().upsert(TASK)
    useDownloadStore.getState().upsert({ ...TASK, status: 'completed', progress: 100 })
    const tasks = useDownloadStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('completed')
    expect(tasks[0].progress).toBe(100)
  })

  it('remove deletes by id', () => {
    useDownloadStore.getState().upsert(TASK)
    useDownloadStore.getState().remove('t1')
    expect(useDownloadStore.getState().tasks).toHaveLength(0)
  })
})
