/**
 * 自建主题的存储与导入导出（Phase 3）。
 *
 * 落点是 localStorage 而不是后端：主题是**本机审美资产**，不进排版稿的数据模型
 * （稿只记 theme_id + overrides，见 §4）。要同步就走导出 JSON 那一对动作。
 *
 * 两条护栏：
 * 1. 读档时任何一条脏数据（缺必填 token / id 不带前缀 / 平台不认识）都**跳过**而不是
 *    整份丢弃——用户存了 5 套主题，坏 1 套不该连另外 4 套一起消失。
 * 2. 写档前先 `registerTheme` 校验：校验失败的东西不落盘，否则下次开应用时还是坏。
 */
import {
  clearCustomThemes,
  CUSTOM_THEME_PREFIX,
  getTheme,
  isBuiltinTheme,
  listCustomThemes,
  registerTheme,
  resolveTokens,
  themeWithOverrides,
  unregisterTheme,
  type Theme,
  type ThemeOverrides,
  type ThemePlatform,
} from '@hertz/mdcore'

const STORAGE_KEY = 'hertz.mdstudio.themes.v1'

export interface CustomThemeEntry {
  id: string
  name: string
  platform: ThemePlatform
  tokens: ThemeOverrides
  /** 样式槽覆盖：设计器里改结构样式的部分（tokens 之外的 styles） */
  styles?: Record<string, Record<string, string>>
  updatedAt: number
}

const PLATFORMS: ThemePlatform[] = ['wechat', 'xhs', 'zhihu', 'generic']

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // 隐私模式 / 禁用 storage：设计器退化成"只能导出 JSON"
    return null
  }
}

/** id 规范化：保证带前缀、不是内置名 */
export function normalizeThemeId(raw: string): string {
  // 前缀先摘再净化：`:` 属于危险字符集，不摘掉的话 `user:already` 会被净化成
  // `user-already`，再补前缀就成了 `user:user-already`
  const trimmed = raw.trim();
  const hadPrefix = trimmed.startsWith(CUSTOM_THEME_PREFIX);
  const slug = (hadPrefix ? trimmed.slice(CUSTOM_THEME_PREFIX.length) : trimmed)
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  if (!slug) return `${CUSTOM_THEME_PREFIX}theme`
  const withPrefix = `${CUSTOM_THEME_PREFIX}${slug}`
  // 与内置名撞车时加后缀——用户想把「墨滴」存成自己的主题是合法意图
  return isBuiltinTheme(withPrefix.slice(CUSTOM_THEME_PREFIX.length)) ? `${withPrefix}-1` : withPrefix
}

/** 一条档案 → Theme 对象（补上 styles 与 base 结构） */
export function entryToTheme(entry: CustomThemeEntry): Theme {
  const base = entry.platform === 'generic' ? getTheme('xueshu') : getTheme(firstIdFor(entry.platform))
  return {
    ...base,
    id: entry.id,
    name: entry.name,
    platform: entry.platform,
    tokens: { ...base.tokens, ...entry.tokens },
    styles: { ...base.styles, ...(entry.styles ?? {}) },
  }
}

function firstIdFor(platform: ThemePlatform): string {
  const found = ['modi', 'taoyao', 'xueshu'].find((id) => getTheme(id).platform === platform)
  return found ?? 'modi'
}

/** 校验 + 规范化一条导入档案；不合格抛错（界面据此给提示） */
export function sanitizeEntry(raw: unknown): CustomThemeEntry {
  if (!raw || typeof raw !== 'object') throw new Error('不是对象')
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 40) : '我的主题'
  const platform = PLATFORMS.includes(obj.platform as ThemePlatform) ? (obj.platform as ThemePlatform) : 'generic'
  const tokens = (obj.tokens ?? {}) as ThemeOverrides
  const missing = (['color', 'fontFamily', 'fontSize', 'lineHeight', 'radius'] as const).filter((k) => !tokens[k])
  if (missing.length) throw new Error(`缺少必填 token：${missing.join(', ')}`)
  const id = normalizeThemeId(typeof obj.id === 'string' ? obj.id : name)
  return {
    id,
    name,
    platform,
    tokens,
    styles: (obj.styles as CustomThemeEntry['styles']) ?? undefined,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
  }
}

/** 当前注册表里的自建主题（已从 localStorage 同步进来） */
export function customThemes(): CustomThemeEntry[] {
  return listCustomThemes().map((t) => {
    const theme = getTheme(t.id)
    const base = themeWithOverrides({ ...theme, tokens: { ...theme.tokens } }, {})
    return {
      id: t.id,
      name: t.name,
      platform: t.platform,
      tokens: theme.tokens,
      styles: Object.keys(theme.styles).length > Object.keys(base.styles).length ? theme.styles : undefined,
      updatedAt: 0,
    }
  })
}

function readRaw(): CustomThemeEntry[] {
  const store = storage()
  if (!store) return []
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    // 逐条 sanitize：坏一条只丢那一条
    const out: CustomThemeEntry[] = []
    for (const item of parsed) {
      try {
        out.push(sanitizeEntry(item))
      } catch {
        /* 脏数据跳过，不影响其它主题 */
      }
    }
    return out
  } catch {
    return []
  }
}

function writeRaw(entries: CustomThemeEntry[]): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(entries))
}

/**
 * 启动时调用：把 localStorage 里的自建主题灌进 mdcore 注册表。
 * 返回成功载入的条数（界面上要能说"有 2 套自建主题"）。
 */
export function hydrateCustomThemes(): number {
  clearCustomThemes()
  const entries = readRaw()
  let ok = 0;
  for (const entry of entries) {
    try {
      registerTheme(entryToTheme(entry));
      ok += 1;
    } catch {
      /* 校验不过的不进注册表 */
    }
  }
  return ok
}

/** 把某套内置主题（或当前 overrides）另存为我的主题 */
export function saveCustomTheme(entry: Omit<CustomThemeEntry, 'updatedAt'>): CustomThemeEntry {
  const full: CustomThemeEntry = { ...entry, updatedAt: Date.now() };
  const clean = sanitizeEntry(full);
  // 先校验再落盘：不合格的东西不写进存储
  registerTheme(entryToTheme(clean));
  const rest = readRaw().filter((e) => e.id !== clean.id);
  writeRaw([...rest, clean]);
  return clean
}

export function deleteCustomTheme(id: string): boolean {
  const removed = unregisterTheme(id);
  writeRaw(readRaw().filter((e) => e.id !== id));
  return removed
}

/** 导出：一份自包含 JSON（含 schema 版本，好让将来能迁移） */
export function exportThemes(ids?: string[]): string {
  const entries = readRaw().filter((e) => !ids || ids.includes(e.id));
  return JSON.stringify({ schema: 'hertz.mdstudio.themes', version: 1, themes: entries }, null, 2)
}

/** 导入：返回实际入库的条数；整份文件不合法时抛错 */
export function importThemes(json: string, { replace = false }: { replace?: boolean } = {}): number {
  const parsed = JSON.parse(json) as { themes?: unknown } | unknown[]
  const list = Array.isArray(parsed) ? parsed : (parsed as { themes?: unknown }).themes
  if (!Array.isArray(list)) throw new Error('文件里没有主题数组')
  const entries = list.map((item) => sanitizeEntry(item))
  if (replace) {
    for (const e of readRaw()) unregisterTheme(e.id);
    writeRaw([]);
  }
  for (const entry of entries) {
    registerTheme(entryToTheme(entry));
    const rest = readRaw().filter((e) => e.id !== entry.id);
    writeRaw([...rest, entry]);
  }
  return entries.length
}

/** 设计器里的"当前值"：overrides 优先，否则取主题解析后的值 */
export function currentValue(theme: Theme, overrides: ThemeOverrides, key: string): string {
  const resolved = resolveTokens(theme, overrides);
  return String(resolved[key as keyof typeof resolved] ?? '')
}