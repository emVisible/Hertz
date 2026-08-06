/** Download domain types. */

export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled'

export interface DownloadTask {
  id: string
  url: string
  provider: string
  status: DownloadStatus
  progress: number
  total_bytes: number | null
  downloaded_bytes: number
  file_path: string | null
  error: string | null
  created_at: string | null
  metadata: Record<string, unknown>
}

export interface FormatOption {
  format_id: string
  label: string
  ext: string
  kind: 'video' | 'audio'
  filesize?: number | null
}

export interface QualityOption {
  format_id: string
  label: string
  height: number
  muxed: boolean
}

export interface ParseResult {
  provider: 'bilibili' | 'youtube' | 'generic'
  kind: 'video' | 'audio' | 'image' | 'page'
  title?: string
  duration?: number
  uploader?: string
  thumbnail?: string
  formats?: FormatOption[]
  qualities?: QualityOption[]
  best_audio_id?: string | null
  assets?: { url: string; name: string; kind: string }[]
}

export interface DownloadEvent {
  event: 'created' | 'started' | 'progress' | 'completed' | 'failed' | 'cancelled'
  task: DownloadTask
}
