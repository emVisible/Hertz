import { describe, expect, it } from 'vitest';
import { parseToIR } from '../index';

/**
 * 内联图片地址（v0.36 修）。
 *
 * 这条判据来自**产物层观测**：排版基线图（scripts/typography-baseline.mjs）第一轮
 * 录出来的那张配图，在画布上是一整行被原样打印的 data URL。结构层当时全绿——
 * 因为 markdown-it 把链接判掉之后，`![alt](url)` 变成了普通段落文本，而
 * "解析成 para 而不是 image" 在 151 条断言里没有任何一条在看。
 *
 * 放行范围必须窄：只认 `data:image/<子类型>`，`data:text/html`、`javascript:` 等
 * 仍然拒（前者是 XSS 载体，后者是 markdown-it 默认就禁的）。
 */
// 注意：data URL 里不能有**字面空格**——markdown 语法上空格会终止链接地址，
// 于是 `![图](data:... xmlns=...)` 连图片都算不上（这是夹具第一版的错，不是解析器的错）
const SVG =
  "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='10'%20height='10'%3E%3C/svg%3E";

describe('内联图片地址', () => {
  it('data:image/svg+xml 图片被解析成 image 块（此前静默变成原始文本）', () => {
    const ir = parseToIR(`![示例配图](${SVG})\n`);
    expect(ir.map((b) => b.type)).toEqual(['image']);
    expect((ir[0] as { src: string }).src).toBe(SVG);
    expect((ir[0] as { alt: string }).alt).toBe('示例配图');
  });

  it('逗号写法的 data URL 也认（markdown-it 默认只放行带分号的那几种）', () => {
    const ir = parseToIR('![图](data:image/svg+xml,<svg/>)\n');
    expect(ir[0].type).toBe('image');
  });

  it('markdown-it 本来就放行的那几种 data 图片不受影响（别修坏）', () => {
    for (const src of ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,AAAA', 'data:image/gif;base64,AA']) {
      expect(parseToIR(`![图](${src})\n`)[0].type, src).toBe('image');
    }
  });

  it('http(s) 与相对路径照旧（对照组：不是把所有地址都放行了）', () => {
    expect(parseToIR('![图](https://example.com/a.png)\n')[0].type).toBe('image');
    expect(parseToIR('![图](./local.png)\n')[0].type).toBe('image');
    expect(parseToIR('[链接](https://example.com)\n')[0].type).toBe('para');
  });

  it('危险协议仍然被拒：data:text/html、javascript:、file:', () => {
    expect(parseToIR('[点我](javascript:alert%281%29)\n')[0].type).toBe('para');
    expect(parseToIR('[点我](data:text/html;base64,PHNjcmlwdD4=)\n')[0].type).toBe('para');
    expect(parseToIR('[点我](file:///etc/passwd)\n')[0].type).toBe('para');
    // data:text/html 也不能当图片塞进来
    expect(parseToIR('![图](data:text/html;base64,PHNjcmlwdD4=)\n')[0].type).toBe('para');
  });
});