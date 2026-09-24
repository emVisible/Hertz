/** 设置页保存载荷（v0.32 S4.1）：草稿 → 只回传被改过的项，类型按配置真值还原。

 为什么单独成模块：v0.20 把 SettingsPage 拆分时，`save()` 里的字段表被删空成
 `overrides: {}`——此后所有输入框都是装饰品（点保存弹「已保存」，runtime.yaml
 一个字节没写）。字段表逐字段手写就是下一次漂移的源头，所以这里改成
 「以配置接口回来的实际类型为准」：布尔/数字/数组的还原只有一条规则，
 新增设置项不需要动这个函数。
 */

const BOOL = 'true'

export function coerceFromBase(base: unknown, raw: string): unknown {
  if (typeof base === 'boolean') return raw === BOOL
  if (typeof base === 'number') return Number(raw)
  if (Array.isArray(base)) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return raw
}

function unchanged(base: unknown, value: unknown): boolean {
  if (Array.isArray(base) && Array.isArray(value)) {
    return base.join('\u0000') === value.join('\u0000')
  }
  return base === value || String(base) === String(value)
}

/** 草稿与当前配置的差集。

 - 未改动的项不发：后端 PATCH 是整体 merge，多发无害但会把「用户没碰过的只写
   字段」以空串写回去（等于清掉已存的 Reddit cookie / client secret）。
 - 配置里没有该项（SECRET_FIELDS 被后端滤掉，只写不读）时，空串按「不改动」处理。
 */
export function buildOverrides(
  cfg: unknown,
  form: Record<string, string>,
): Record<string, unknown> {
  const src = (cfg ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(form)) {
    const base = src[key]
    if (base === undefined || base === null) {
      if (raw !== '') out[key] = raw
      continue
    }
    const value = coerceFromBase(base, raw)
    if (!unchanged(base, value)) out[key] = value
  }
  return out
}
