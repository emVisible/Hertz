/** LLM 相关单一真相源（AXIOM §1.2）：模型目录/超时/重试选项只定义一次。
 * 任何页面（编排 tab 的工序/团队编辑器、设置页）都从这里取，禁止各自内联。 */

export interface SelectOption {
  value: string
  label: string
}

/** 云模型 Select 目录（工序/团队编辑器共用；本地模型在设置页按 provider 提供）。 */
export const MODEL_OPTIONS: string[] = [
  'deepseek-chat',
  'deepseek-reasoner',
  'gpt-4o-mini',
  'gpt-4o',
  'claude-sonnet-4',
  'gemini-2.0-flash',
]

/** 把当前值并入选项：不在目录里的自定义值显示为「xxx (自定义)」而非空白。 */
export function withCustomOption(
  options: SelectOption[],
  current: string | number | undefined,
  known: readonly string[],
  labelSuffix = '',
): SelectOption[] {
  const value = String(current ?? '')
  const already = known.includes(value) || options.some((o) => o.value === value)
  if (value && !already) {
    return [{ value, label: `${value}${labelSuffix}` }, ...options]
  }
  return options
}

export function modelOptions(current?: string): SelectOption[] {
  return withCustomOption(
    MODEL_OPTIONS.map((m) => ({ value: m, label: m })),
    current,
    MODEL_OPTIONS,
  )
}

export const RETRY_OPTIONS = [0, 1, 2, 3, 5]

export function retryOptions(current?: number): SelectOption[] {
  return withCustomOption(
    RETRY_OPTIONS.map((r) => ({ value: String(r), label: String(r) })),
    current,
    RETRY_OPTIONS.map(String),
  )
}

export const TIMEOUT_OPTIONS = [60, 120, 300, 600, 900, 1800]

export function timeoutOptions(current?: number): SelectOption[] {
  return withCustomOption(
    TIMEOUT_OPTIONS.map((s) => ({ value: String(s), label: `${s}s` })),
    current,
    TIMEOUT_OPTIONS.map(String),
    's (custom)',
  )
}
