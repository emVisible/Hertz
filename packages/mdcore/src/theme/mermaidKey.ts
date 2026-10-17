/**
 * Mermaid 源码的稳定键（FNV-1a 32bit，十六进制）。
 *
 * 为什么需要键：预渲染 cache 的键必须**跨两次渲染稳定**，而不能是数组下标——
 * 用户在稿子中间插一段话，下标全变，已渲染的图会集体失配、重算一遍。
 * 用源码内容本身当键则与位置无关：同样的图在稿子里移动位置仍命中缓存。
 *
 * 碰撞顾虑：32bit 在一篇稿几十张图的量级下概率极低，且**碰撞的后果只是
 * 复用了另一张同哈希的 SVG**，不会丢内容（源码仍可从 IR 取回）。真出问题时
 * 表现是"某张图长得像另一张"，属可见症状而不是静默失效。
 */
export function mermaidKeyOf(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i += 1) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `m${h.toString(16).padStart(8, '0')}`;
}