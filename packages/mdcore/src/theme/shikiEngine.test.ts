import { describe, expect, it } from 'vitest';
import { applyTheme, highlightCodeBlocks, parseToIR } from '../index';

describe('真 Shiki 引擎（不是替身）', () => {
  it('默认引擎把 hljs 产物升级成 Shiki 内联色', async () => {
    const el = applyTheme(parseToIR('```ts\nconst a: number = 1\n```'), 'modi');
    const before = el.querySelector('code')?.innerHTML ?? '';
    expect(before).toContain('hljs-');
    const n = await highlightCodeBlocks(el, { themeName: 'github-light' });
    const after = el.querySelector('code')?.innerHTML ?? '';
    expect(n).toBe(1);
    expect(after).not.toContain('hljs-');
    expect(after).toMatch(/style="color:#[0-9A-Fa-f]{6}"/);
  }, 30000);

  it('objective-c 走语言名映射（hljs 的 objectivec → Shiki 的 objective-c）', async () => {
    const el = applyTheme(parseToIR('```objc\nint main() { return 0; }\n```'), 'modi');
    const n = await highlightCodeBlocks(el, { themeName: 'github-light' });
    expect(n).toBe(1);
  }, 30000);

  it('包外语言不接管（wasm 等）→ 保留 hljs', async () => {
    const el = applyTheme(parseToIR('```wasm\n(module)\n```'), 'modi');
    expect(await highlightCodeBlocks(el, { themeName: 'github-light' })).toBe(0);
  }, 30000);
});
