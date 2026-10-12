import { contextBridge, ipcRenderer } from 'electron'

const windowApi = {
  platform: process.platform as NodeJS.Platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  showItemInFolder: (filePath: string) => ipcRenderer.send('shell:show-in-folder', filePath),
  /** 系统目录选择对话框：返回绝对路径或 null（取消）。 */
  pickDirectory: (currentPath?: string) =>
    ipcRenderer.invoke('dialog:pick-directory', currentPath ?? '') as Promise<string | null>,
  /** 自定义简约弹窗按钮回传（主进程按通道订阅，无默认 Electron 图标）。 */
  respondToDialog: (channel: string, id: string) => ipcRenderer.send(channel, id),
  /** 剪贴板监控开关：对应 settings 的 `clipboard_monitor_enabled`。 */
  setClipboardMonitor: (enabled: boolean) =>
    ipcRenderer.send('clipboard:monitor', enabled),
  notifyDownloadDone: (name: string) => ipcRenderer.send('notify:download-done', name),
  notifyPublish: (title: string, ok: boolean) =>
    ipcRenderer.send('notify:publish', title, ok),
  /** 剪贴板命中链接：返回清理后的 URL（主进程通知点击时触发）。 */
  onClipboardParse: (cb: (url: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, url: string) => cb(url)
    ipcRenderer.on('clipboard:parse', listener)
    return () => ipcRenderer.removeListener('clipboard:parse', listener)
  },
}

contextBridge.exposeInMainWorld('electron', windowApi)

export type WindowApi = typeof windowApi
