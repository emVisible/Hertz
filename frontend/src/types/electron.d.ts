export {}

declare global {
  interface Window {
    electron?: {
      platform: string
      minimize: () => void
      toggleMaximize: () => void
      close: () => void
      showItemInFolder: (filePath: string) => void
      pickDirectory: (currentPath?: string) => Promise<string | null>
      setClipboardMonitor: (enabled: boolean) => void
      notifyDownloadDone: (name: string) => void
      notifyPublish: (title: string, ok: boolean) => void
      onClipboardParse: (cb: (url: string) => void) => () => void
    }
  }
}
