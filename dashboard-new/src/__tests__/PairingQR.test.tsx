import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PairingQR } from '@/components/PairingQR'

// PairingQR renders a scannable QR of the pairing URL so a phone can pair the
// installable app by scanning instead of copy-pasting a long JWT (card 408c4248).
describe('PairingQR', () => {
  it('renders an SVG QR code for a pairing URL', () => {
    const { container } = render(
      <PairingQR url="http://localhost:3420/v2/#token=abc.def.ghi" />
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // qrcode.react draws the modules as <path> elements inside the svg
    expect(svg?.querySelector('path')).not.toBeNull()
  })

  it('renders nothing when there is no url (nothing to pair yet)', () => {
    const { container } = render(<PairingQR url="" />)
    expect(container.querySelector('svg')).toBeNull()
  })
})
