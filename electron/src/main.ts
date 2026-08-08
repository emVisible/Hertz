import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const DEV_SERVER_URL = process.env.HERTZ_FRONTEND_URL ?? 'http://localhost:3000'
const BACKEND_URL = process.env.HERTZ_BACKEND_URL
const BACKEND_PORT = process.env.HERTZ_BACKEND_PORT ?? '8787'

let backendProcess: ChildProcess | null = null

function registerWindowIpc(): void {
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('shell:show-in-folder', (e, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return
    shell.showItemInFolder(filePath)
  })
  // 目录选择（设置页路径配置）：返回用户选择的绝对路径，取消返回 null
  ipcMain.handle('dialog:pick-directory', async (e, currentPath: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof currentPath === 'string' && currentPath ? currentPath : undefined,
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

function startBackend(): void {
  if (BACKEND_URL) return
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(app.getAppPath(), '..', 'backend')
  const python = process.env.HERTZ_PYTHON ?? 'python3'
  backendProcess = spawn(
    python,
    ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', BACKEND_PORT],
    { cwd: backendDir, stdio: 'ignore', env: { ...process.env } },
  )
  backendProcess.on('error', (err) => {
    dialog.showErrorBox(
      'Hertz 后端启动失败',
      `无法启动后端服务（${err.message}）。\n\n请确认已安装 Python 与依赖（见 USER_GUIDE），\n或设置 HERTZ_BACKEND_URL 指向外部后端后重启。`,
    )
  })
  backendProcess.unref()
}

async function waitForBackend(timeoutMs = 15_000): Promise<boolean> {
  const healthUrl = `http://127.0.0.1:${BACKEND_PORT}/api/health`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(healthUrl)
      if (resp.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

function setupAutoUpdate(): void {
  if (!app.isPackaged || !process.env.HERTZ_UPDATE_URL) return
  // electron-updater loaded lazily so dev mode never pulls it in
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
  autoUpdater.autoDownload = true
  autoUpdater.on('update-downloaded', () => {
    void dialog
      .showMessageBox({
        type: 'info',
        title: '更新可用',
        message: '新版 Hertz 已下载，重启安装？',
        buttons: ['稍后', '重启安装'],
        defaultId: 1,
      })
      .then(({ response }) => {
        if (response === 1) autoUpdater.quitAndInstall()
      })
  })
  autoUpdater.checkForUpdates().catch(() => {
    /* offline or no release channel — silent */
  })
}

function createWindow(): void {
  const saved = loadWindowBounds()
  const win = new BrowserWindow({
    x: saved?.x,
    y: saved?.y,
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Hertz',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => saveWindowBounds(win), 400)
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    saveWindowBounds(win)
  })

  if (app.isPackaged) {
    void win.loadFile(path.join(process.resourcesPath, 'renderer', 'index.html'))
  } else {
    void win.loadURL(DEV_SERVER_URL)
  }
}

// ---- 剪贴板监听（HeartStone heritage）：命中 B站/YouTube 链接 → 通知 → 回填下载页 ----
let clipboardTimer: ReturnType<typeof setInterval> | null = null
let lastClipboard = ''

const URL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'bilibili', re: /(?:bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}|\/av\d+)/i },
  { name: 'youtube', re: /(?:youtube\.com|youtu\.be)/i },
]

export function startClipboardMonitor(): void {
  if (clipboardTimer) return
  lastClipboard = clipboard.readText()
  clipboardTimer = setInterval(() => {
    const text = clipboard.readText()
    if (!text || text === lastClipboard) return
    lastClipboard = text
    const hit = URL_PATTERNS.find((p) => p.re.test(text))
    if (!hit) return
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (!Notification.isSupported()) return
    const notice = new Notification({
      title: 'Hertz · 剪贴板检测',
      body: `检测到${hit.name === 'bilibili' ? 'B站' : 'YouTube'}链接，点击前往下载`,
    })
    notice.on('click', () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('clipboard:parse', text.trim())
    })
    notice.show()
  }, 1500)
}

function stopClipboardMonitor(): void {
  if (clipboardTimer) {
    clearInterval(clipboardTimer)
    clipboardTimer = null
  }
}

// ---- 下载完成系统通知（HeartStone heritage） ----
ipcMain.on('notify:download-done', (_e, name: string) => {
  if (!Notification.isSupported()) return
  new Notification({ title: 'Hertz · 下载完成', body: `${name ?? '任务'} 已完成` }).show()
})

// ---- 窗口位置记忆（HeartStone heritage） ----
function boundsPath(): string {
  return path.join(app.getPath('userData'), 'window-bounds.json')
}

function loadWindowBounds(): { x?: number; y?: number; width: number; height: number } | null {
  try {
    const raw = fs.readFileSync(boundsPath(), 'utf-8')
    const data = JSON.parse(raw) as { x?: number; y?: number; width?: number; height?: number }
    if (typeof data.width !== 'number' || typeof data.height !== 'number') return null
    return { x: data.x, y: data.y, width: data.width, height: data.height }
  } catch {
    return null
  }
}

function saveWindowBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds()
    fs.writeFileSync(boundsPath(), JSON.stringify(bounds))
  } catch {
    /* best effort */
  }
}

app.whenReady().then(async () => {
  // dev 模式下 Electron.app 是默认图标：用 dock.setIcon 换成 Hertz 自己的
  //（打包版由 build/icon.icns 经 electron-builder 写入 .app，无需处理）。
  if (process.platform === 'darwin' && !app.isPackaged) {
    const devIcon = path.join(app.getAppPath(), 'build', 'icon.png')
    try {
      app.dock?.setIcon(devIcon)
    } catch {
      /* icon missing or dock unavailable — keep default */
    }
  }

  registerWindowIpc()
  createWindow()
  setupAutoUpdate()
  startClipboardMonitor()

  if (app.isPackaged) {
    startBackend()
    const ok = await waitForBackend()
    if (!ok) {
      dialog.showMessageBox({
        type: 'warning',
        title: '后端未就绪',
        message: `无法连接后端服务（${BACKEND_URL ?? `http://127.0.0.1:${BACKEND_PORT}`}）。\n\n功能将不可用。请确认 Python 依赖已安装，或设置 HERTZ_BACKEND_URL。`,
      })
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopClipboardMonitor()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  backendProcess?.kill()
  backendProcess = null
})
