// 内嵌 PostgreSQL（v0.21 P0 安装即用）：打包版首启自动拉取 zonky 发行包到
// userData，initdb + pg_ctl 托管子进程——新机器零配置可用。
//
// 边界与兼容：
// - 仅打包态生效（dev 态走系统 PG / scripts/dev.sh）；HERTZ_EMBEDDED_PG=1 可强制启用调试
// - 显式设置 HERTZ_BACKEND_URL 或 HERTZ_DATABASE_URL 时完全跳过（外部库用户）
// - 动态空闲端口，不与系统 PG(5432) 冲突；unix socket 放 PGDATA/s（路径短）
// - zonky 包不含 createdb：建库由后端启动器用 asyncpg 兜底（scripts/run_backend.py）

import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { connect, createServer } from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

// 版本单一真相源：zonky darwin-arm64v8 与开发机 postgresql@18 同大版本
const PG_VERSION = '18.4.0'
const JAR_URL =
  `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-darwin-arm64v8/` +
  `${PG_VERSION}/embedded-postgres-binaries-darwin-arm64v8-${PG_VERSION}.jar`

let pgProcess: ChildProcess | null = null
let activePort = 0

export interface EmbeddedPgPaths {
  root: string
  binDir: string
  dataDir: string
  sockDir: string
  logFile: string
}

function pgRoot(): string {
  return path.join(app.getPath('userData'), 'pg')
}

function paths(): EmbeddedPgPaths {
  const root = pgRoot()
  return {
    root,
    binDir: path.join(root, 'bin'),
    dataDir: path.join(root, 'data'),
    sockDir: path.join(root, 'data', 's'),
    logFile: path.join(root, 'pg.log'),
  }
}

/** 是否应启用内嵌 PG（打包态 + 用户未显式指定外部库）。 */
export function shouldEmbedPg(): boolean {
  if (process.env.HERTZ_DATABASE_URL || process.env.HERTZ_BACKEND_URL) return false
  if (process.env.HERTZ_EMBEDDED_PG === '0') return false
  return app.isPackaged || process.env.HERTZ_EMBEDDED_PG === '1'
}

function log(msg: string): void {
  console.log(`[embedded-pg] ${msg}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
    srv.on('error', reject)
  })
}

async function tcpReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const client = connect({ port, host: '127.0.0.1' })
      client.once('connect', () => {
        client.destroy()
        resolve(true)
      })
      client.once('error', () => resolve(false))
      setTimeout(() => {
        client.destroy()
        resolve(false)
      }, 1500)
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function download(url: string, dest: string): Promise<void> {
  const resp = await fetch(url)
  if (!resp.ok || !resp.body) throw new Error(`下载 PostgreSQL 发行包失败 (HTTP ${resp.status})`)
  await pipeline(Readable.fromWeb(resp.body as never), fs.createWriteStream(dest))
}

function run(bin: string, args: string[], label: string): void {
  const r = spawnSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) {
    throw new Error(`${label} 失败 (exit ${r.status}):\n${r.stderr || r.stdout}`)
  }
  log(`${label} ok`)
}

async function install(p: EmbeddedPgPaths): Promise<void> {
  log(`installing PostgreSQL ${PG_VERSION} → ${p.root}`)
  fs.mkdirSync(p.root, { recursive: true })
  const jarPath = path.join(p.root, `pg-${PG_VERSION}.jar`)
  await download(JAR_URL, jarPath)

  // jar(zip) → 内层 txz(tar+xz)；macOS 系统自带 unzip/tar 即可
  run('/usr/bin/unzip', ['-o', '-q', jarPath, `postgres-darwin-arm_64.txz`, '-d', p.root], 'unzip')
  run(
    '/usr/bin/tar',
    ['-xJf', path.join(p.root, 'postgres-darwin-arm_64.txz'), '-C', p.root],
    'extract',
  )
  fs.rmSync(path.join(p.root, 'postgres-darwin-arm_64.txz'), { force: true })
  fs.rmSync(jarPath, { force: true })
  for (const b of ['initdb', 'pg_ctl', 'postgres']) {
    fs.chmodSync(path.join(p.binDir, b), 0o755)
  }

  fs.mkdirSync(p.dataDir, { recursive: true })
  run(
    path.join(p.binDir, 'initdb'),
    [
      '-D',
      p.dataDir,
      '-U',
      'hertz',
      '--auth=trust',
      '--no-locale',
      '--encoding=UTF8',
      `--pgdata=${p.dataDir}`,
    ],
    'initdb',
  )
  fs.writeFileSync(path.join(p.root, `.installed-${PG_VERSION}`), 'ok')
  log('install complete')
}

/** 启动内嵌 PG；返回需注入后端进程的环境变量。 */
export async function ensureEmbeddedPg(): Promise<Record<string, string>> {
  const p = paths()

  // 已在运行（同数据目录二次启动）→ 直接复用
  if (activePort && (await tcpReady(activePort, 1000))) {
    log(`already running on :${activePort}`)
    return baseEnv(p, activePort)
  }

  const marker = path.join(p.root, `.installed-${PG_VERSION}`)
  if (!fs.existsSync(marker)) {
    await install(p)
  }

  // 崩溃残留的陈旧 postmaster.pid：进程已死才清理（活进程则复用）
  const pidFile = path.join(p.dataDir, 'postmaster.pid')
  if (fs.existsSync(pidFile)) {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').split('\n')[0] ?? '', 10)
    let alive = false
    try {
      alive = pid > 0 && process.kill(pid, 0)
    } catch {
      alive = false
    }
    if (!alive) {
      log(`stale postmaster.pid (pid ${pid}) — cleaning`)
      fs.rmSync(pidFile, { force: true })
      fs.rmSync(path.join(p.dataDir, 'postmaster.opts'), { force: true })
    }
  }

  const port = await freePort()
  fs.mkdirSync(p.sockDir, { recursive: true })
  log(`starting on :${port}`)
  pgProcess = spawn(
    path.join(p.binDir, 'pg_ctl'),
    [
      'start',
      '-D',
      p.dataDir,
      '-w',
      '-t',
      '60',
      '-l',
      p.logFile,
      '-o',
      `-p ${port} -k ${p.sockDir} -c listen_addresses=127.0.0.1`,
    ],
    { stdio: 'ignore' },
  )

  const ready = await tcpReady(port, 45_000)
  if (!ready) {
    const tail = (() => {
      try {
        return fs.readFileSync(p.logFile, 'utf-8').split('\n').slice(-12).join('\n')
      } catch {
        return ''
      }
    })()
    throw new Error(`内嵌 PostgreSQL 启动超时。\n\n日志尾部:\n${tail}`)
  }
  activePort = port
  log(`ready on :${port}`)
  return baseEnv(p, port)
}

function baseEnv(p: EmbeddedPgPaths, port: number): Record<string, string> {
  const ud = app.getPath('userData')
  return {
    HERTZ_DATABASE_URL: `postgresql+asyncpg://hertz@127.0.0.1:${port}/hertz`,
    // 数据/产物/日志落 userData（app bundle 内只读）
    ...(process.env.HERTZ_DATA_DIR ? {} : { HERTZ_DATA_DIR: path.join(ud, 'data') }),
    ...(process.env.HERTZ_OUTPUT_DIR ? {} : { HERTZ_OUTPUT_DIR: path.join(ud, 'output') }),
    ...(process.env.HERTZ_LOG_DIR ? {} : { HERTZ_LOG_DIR: path.join(ud, 'logs') }),
  }
}

/** 应用退出时停库（fast 模式：断连接回滚后关闭）。 */
export function stopEmbeddedPg(): void {
  if (!shouldEmbedPg()) return
  try {
    const p = paths()
    if (fs.existsSync(path.join(p.binDir, 'pg_ctl'))) {
      spawnSync(path.join(p.binDir, 'pg_ctl'), ['stop', '-D', p.dataDir, '-m', 'fast'], {
        stdio: 'ignore',
        timeout: 20_000,
      })
      log('stopped')
    }
  } catch (e) {
    log(`stop failed: ${String(e)}`)
  } finally {
    pgProcess = null
    activePort = 0
  }
}
