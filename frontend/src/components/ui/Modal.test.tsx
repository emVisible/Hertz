import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Modal } from './Modal'

describe('Modal', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}}>
        content
      </Modal>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders title and children when open', () => {
    render(
      <Modal open title="Confirm" onClose={() => {}}>
        <p>Are you sure?</p>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByText('Are you sure?')).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        content
      </Modal>,
    )
    await act(async () => {
      await userEvent.keyboard('{Escape}')
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
