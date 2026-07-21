import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavShell } from './NavShell'

describe('NavShell', () => {
  it('renders every enabled tab as a button and disables the F1 Brain tab', () => {
    render(
      <NavShell active="home" onSelect={() => {}}>
        <div>body</div>
      </NavShell>,
    )
    expect(screen.getByRole('button', { name: 'Mission Control' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Kanban' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Gate Board' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Hook Stream' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Brain/ })).toBeDisabled()
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('calls onSelect with the tab key when an enabled tab is clicked', () => {
    const onSelect = vi.fn()
    render(
      <NavShell active="home" onSelect={onSelect}>
        <div />
      </NavShell>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Gate Board' }))
    expect(onSelect).toHaveBeenCalledWith('gate')
  })

  it('does not fire onSelect for the disabled Brain tab', () => {
    const onSelect = vi.fn()
    render(
      <NavShell active="home" onSelect={onSelect}>
        <div />
      </NavShell>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Brain/ }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps the tab bar on one scrollable row (no wrap) so mobile tabs stay whole', () => {
    const { container } = render(
      <NavShell active="home" onSelect={() => {}}>
        <div />
      </NavShell>,
    )
    const nav = container.querySelector('nav')
    expect(nav?.className).toMatch(/overflow-x-auto/)
    // buttons must not shrink/wrap their label
    const tab = screen.getByRole('button', { name: 'Mission Control' })
    expect(tab.className).toMatch(/whitespace-nowrap/)
    expect(tab.className).toMatch(/shrink-0/)
  })
})
