import { cn } from '@/lib/cn'
import { SEAT_CHIP, SEAT_GLYPH, SEAT_LABEL } from '@/lib/gate'
import type { GateSeat } from '@/types/gate'

/** One reviewer-seat cell in the gate matrix. The glyph is decorative; the verdict
 *  is exposed via aria-label + title so it is never colour-only (a11y). */
export function SeatCell({ seat }: { seat: GateSeat }) {
  return (
    <span
      role="img"
      aria-label={SEAT_LABEL[seat]}
      title={SEAT_LABEL[seat]}
      className={cn('inline-flex h-6 w-6 items-center justify-center rounded-full', SEAT_CHIP[seat])}
    >
      <span aria-hidden className="text-sm font-semibold leading-none">
        {SEAT_GLYPH[seat]}
      </span>
    </span>
  )
}
