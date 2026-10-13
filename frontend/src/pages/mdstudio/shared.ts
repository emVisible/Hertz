/** MD Studio 三栏共用的几个小工具（导出落盘、文件名净化、让出主线程）。
 *
 * 单独成文件是因为它们现在有两个消费方：单篇导出（MdStudioPage.runExport）与
 * 批量出图（BatchExportModal）。曾经 downloadBlob 写在页面里，批量那一片就抄了第二份。
 */

/** Blob → 浏览器下载（Electron 下走宿主下载通道） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * ZIP 条目名净化：路径分隔符、控制字符、保留名一律换成下划线。
 * 不做这件事的后果是解压端踩 zip slip（条目名 `../../x`），且中文稿名里的
 * `:` `?` 在 Windows 上直接落不了盘。
 */
export function safeEntryName(raw: string, fallback = 'untitled'): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return (cleaned || fallback).slice(0, 60)
}

/** 批量队列每篇之间让出一次主线程，进度条才动得起来（导出本身是同步重活） */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 批次文件名：mdstudio-batch-YYYYMMDD-HHmm.zip */
export function batchFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `mdstudio-batch-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`
}