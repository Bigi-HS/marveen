// Tests for the manual connect (first-run token entry) in MobileSetup.
// TDD: written before the implementation (card 5e95c777).
// Context: the installable app loads the remote funnel origin (same-origin API),
// but the only token path today is the #token= deep-link fragment, which a
// first-run mobile webview cannot receive. This paste field is the bridge:
// Boss generates a token on the desktop dashboard, pastes the link/token here,
// and the app persists it to the same localStorage key getToken() reads.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MobileSetup } from '@/pages/app/MobileSetup'
import { getToken } from '@/lib/api'

describe('MobileSetup -- manual connect (first-run token entry)', () => {
  beforeEach(() => localStorage.clear())

  it('persists a pasted pairing link and calls onConnected', () => {
    const onConnected = vi.fn()
    render(<MobileSetup onConnected={onConnected} />)
    const input = screen.getByLabelText(/setup link vagy token/i)
    fireEvent.change(input, {
      target: { value: 'https://bigi.tail1a5fa5.ts.net/v2/#token=jwt.aaa.bbb' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^csatlakozás$/i }))
    expect(getToken()).toBe('jwt.aaa.bbb')
    expect(onConnected).toHaveBeenCalledOnce()
  })

  it('persists a bare raw token too', () => {
    const onConnected = vi.fn()
    render(<MobileSetup onConnected={onConnected} />)
    fireEvent.change(screen.getByLabelText(/setup link vagy token/i), {
      target: { value: 'jwt.ccc.ddd' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^csatlakozás$/i }))
    expect(getToken()).toBe('jwt.ccc.ddd')
  })

  it('shows an error and does not connect on invalid input', () => {
    const onConnected = vi.fn()
    render(<MobileSetup onConnected={onConnected} />)
    fireEvent.change(screen.getByLabelText(/setup link vagy token/i), {
      target: { value: 'not a token' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^csatlakozás$/i }))
    expect(onConnected).not.toHaveBeenCalled()
    expect(getToken()).toBeNull()
    expect(screen.getByText(/érvénytelen/i)).toBeInTheDocument()
  })

  it('the connect field is available even with no active session (first run)', () => {
    render(<MobileSetup />)
    // reachable without an existing token -- this is the whole point of first-run
    expect(screen.getByLabelText(/setup link vagy token/i)).toBeInTheDocument()
  })
})
