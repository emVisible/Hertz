import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Button } from './Button'

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Run</Button>)
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()
  })

  it('applies primary variant by default', () => {
    render(<Button>Save</Button>)
    expect(screen.getByRole('button')).toHaveClass('bg-primary')
  })

  it('is disabled while loading and does not fire onClick', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Deploy
      </Button>,
    )
    const btn = screen.getByRole('button')
    expect(btn).toBeDisabled()
    await userEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })
})
