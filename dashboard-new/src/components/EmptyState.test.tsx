import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the message', () => {
    render(<EmptyState message="Nincs adat" />)
    expect(screen.getByText('Nincs adat')).toBeInTheDocument()
  })

  it('default variant is a prominent dashed panel', () => {
    render(<EmptyState message="Üres" />)
    const el = screen.getByText('Üres')
    expect(el.className).toMatch(/border-dashed/)
    expect(el.className).toMatch(/py-6/)
  })

  it('compact variant drops the box and stays a quiet caption (lower visual weight)', () => {
    render(<EmptyState message="Üres" compact />)
    const el = screen.getByText('Üres')
    expect(el.className).not.toMatch(/border-dashed/)
    expect(el.className).toMatch(/text-xs/)
  })
})
