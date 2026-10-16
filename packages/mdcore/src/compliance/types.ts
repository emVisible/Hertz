/** 敏感词扫描结果模型（v0.37 P0-1）——与 IRDiagnostic 同属「发现」体系，两者
在诊断横幅里可以并排出现，互不干扰。 */

export type ComplianceCategory =
  | 'violence'
  | 'sexual'
  | 'political'
  | 'abuse'
  | 'spam'
  | 'metaphysics'

export interface ComplianceFinding {
  /** 命中的词（词表原形，与白名单比对）。 */
  term: string
  category: ComplianceCategory
  /** 命中文本（可能带逃逸分隔符，匹配后还原） */
  matched: string
  /** 源码行（0 起） */
  line: number
}

/**
 * 画布里与合规横幅并排出现的文案（i18n 由宿主传入）。
 *
 * 与 IRDiagnostic 同属「发现」体系的展示端：未建模语法、未渲染块型、敏感词
 * 三类账并列在诊断横幅区域。
 */
export interface ComplianceLabels {
  /** 摘要，`{{count}}` = 出现处数之和 */
  summary: string
  expand: string
  collapse: string
  /** 忽略某词，`{{term}}` = 被忽略的词 */
  ignore: string
  /** 每行类别名 */
  category: Record<string, string>
  /** 行号，`{{line}}` = 源码行（1 起） */
  line: string
}

export interface ComplianceResult {
  findings: ComplianceFinding[]
  categories: Set<ComplianceCategory>
}
