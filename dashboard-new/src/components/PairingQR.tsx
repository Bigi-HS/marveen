import { QRCodeSVG } from 'qrcode.react'

interface PairingQRProps {
  url: string
  /** Pixel size of the QR square. Defaults to a comfortable scanning size. */
  size?: number
}

/**
 * Scannable QR of the pairing URL. A phone scans this to pair the installable app
 * instead of copy-pasting a long JWT link (card 408c4248). Renders on a white,
 * padded card so the quiet zone stays intact against the dark dashboard theme.
 */
export function PairingQR({ url, size = 180 }: PairingQRProps) {
  if (!url) return null
  return (
    <div className="inline-block rounded-lg bg-white p-3">
      <QRCodeSVG value={url} size={size} level="M" marginSize={2} />
    </div>
  )
}
