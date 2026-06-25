import { useState } from 'react'
import { cn } from '@/lib/cn'

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

/**
 * Agent avatar with an initials fallback. The avatar endpoint is public (no auth)
 * and 404s when no file exists, so we swap to initials on error or when the roster
 * reports no avatar.
 */
export function Avatar({ name, hasAvatar, className }: { name: string; hasAvatar: boolean; className?: string }) {
  const [failed, setFailed] = useState(false)
  const showImage = hasAvatar && !failed

  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-elevated text-xs font-medium text-text-muted',
        className,
      )}
    >
      {showImage ? (
        <img
          src={`/api/agents/${encodeURIComponent(name)}/avatar`}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  )
}
