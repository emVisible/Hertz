/** 错误消息提取（v0.8 查漏补缺）：统一 toast 兜底文案格式。 */

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
