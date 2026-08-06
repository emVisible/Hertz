/** 自增 ID + 随机短 ID 生成。 */

let counter = 0

export function nextId(prefix = 'c'): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

export function randomId(prefix = 's', len = 8): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `${prefix}-${out}`
}
