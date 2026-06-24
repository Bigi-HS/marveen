import { cn } from '@/lib/cn'

/** Loading placeholder (section 7: show a skeleton, not a blank area). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-bg-elevated', className)} />
}
