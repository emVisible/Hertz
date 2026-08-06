import { beforeEach, describe, expect, it } from 'vitest'

import { applyTheme, useThemeStore } from './theme'

describe('theme store', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'dark' })
    document.documentElement.classList.remove('dark')
  })

  it('defaults to dark', () => {
    expect(useThemeStore.getState().theme).toBe('dark')
  })

  it('toggles between dark and light', () => {
    useThemeStore.getState().toggle()
    expect(useThemeStore.getState().theme).toBe('light')
    useThemeStore.getState().toggle()
    expect(useThemeStore.getState().theme).toBe('dark')
  })

  it('applyTheme toggles the dark class on the root element', () => {
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
