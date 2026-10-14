/**
 * 画布那条「一次解析、两份账」的缝，单独抽出来。
 *
 * 为什么值得抽：这缝本来是 effect 里两行赋值，没有判据能咬住它——
 * 变异证明（把 `collected.push(...parsed.diagnostics)` 删掉）全绿，
 * 因为今天没有任何一篇合法 markdown 能让渲染账非空，于是"漏收解析账"这种错
 * 不会让任何东西变红。抽成纯函数后就能直接驱动：让 render 回调往账里塞一笔，
 * 断言两半都在。**接线没接线，必须验接线本身**，不能指望它被副作用撞出来。
 */
import { parseToIRDetailed, type IRDiagnostic, type LayoutIR } from '@hertz/mdcore'

/**
 * 解析一次，拿到两份账：
 * - 解析层的账（哪些语法没建模）由 `parseToIRDetailed` 直接给；
 * - 渲染层的账（哪些块型没有渲染分支）由 `render` 回调往同一个数组里追加。
 *
 * 换过去**不增加解析开销**：`parseToIR` 本身就是 `parseToIRDetailed().blocks` 的薄包装。
 */
export function withDiagnostics(
  sourceMd: string,
  render: (ir: LayoutIR, collected: IRDiagnostic[]) => void,
  /**
   * 解析函数可注入（默认 `parseToIRDetailed`）。
   *
   * 为什么留这个口：今天 mdcore 把未建模语法集合守成空集，于是**没有任何一篇合法
   * markdown 能让解析账非空**——不注入的话，"漏收解析账"这种错在判据里撞不出来
   * （试过：变异全绿）。注入一个假解析就能让账非空，这条缝才算真的被验住。
   */
  parse: (md: string) => { blocks: LayoutIR; diagnostics: IRDiagnostic[] } = parseToIRDetailed,
): void {
  const parsed = parse(sourceMd)
  const collected: IRDiagnostic[] = [...parsed.diagnostics]
  render(parsed.blocks, collected)
}
