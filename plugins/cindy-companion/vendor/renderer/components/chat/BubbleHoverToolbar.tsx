// Extracted unchanged BubbleHoverToolbar function from Cindy MessageActionBar.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
export function BubbleHoverToolbar({ side, open = false, besideReactions = false, marker, children }: {
  side: 'left' | 'right'; open?: boolean;
  /** Steps past reactions hung on the bubble's outer top corner. */
  besideReactions?: boolean;
  /** A data attribute that names this toolbar for its caller's tests and checks. */
  marker?: `data-${string}`;
  children: ReactNode;
}) {
  const left = side === 'left';
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} {...(marker ? { [marker]: '' } : {})} data-open={open ? '' : undefined}
      className={cn('pointer-events-none absolute top-0 z-10 w-max rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 data-[open]:pointer-events-auto data-[open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
        left ? 'right-full' : 'left-full', besideReactions ? (left ? 'mr-6' : 'ml-6') : (left ? 'mr-1.5' : 'ml-1.5'))}>
      {children}
    </div>
  );
}
