/** Library domain types. */

export interface LibraryEntry {
  name: string
  path: string
  kind: 'video' | 'audio' | 'image' | 'document' | 'directory' | 'other'
  size: number
  mtime: number
  thumb: string | null
  mime: string | null
  tags?: string[] | null
}

export interface FileInfo extends LibraryEntry {
  media?: {
    duration?: number | null
    codec?: string | null
    width?: number | null
    height?: number | null
    audio_codec?: string | null
    bitrate?: number | null
  }
}
