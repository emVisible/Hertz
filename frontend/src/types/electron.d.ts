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
      notifyDownloadDone: (name: string) => void
      onClipboardParse: (cb: (url: string) => void) => () => void
    }
  }
}
