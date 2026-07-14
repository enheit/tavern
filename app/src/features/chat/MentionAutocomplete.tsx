import type { Member } from "@tavern/shared";
import { cn } from "@/lib/utils";
import { MarketIcon } from "@/features/market/MarketIcon";

// FR-15 mention autocomplete list. Purely presentational — the Composer owns the query, the active
// index (ArrowUp/Down), and selection (Enter/Tab/click). Renders nothing when there are no matches.
interface MentionAutocompleteProps {
  suggestions: Member[];
  activeIndex: number;
  onPick: (member: Member) => void;
  serverId: string;
}

export function MentionAutocomplete({
  suggestions,
  activeIndex,
  onPick,
  serverId,
}: MentionAutocompleteProps) {
  if (suggestions.length === 0) return null;
  return (
    <ul
      data-testid="mention-autocomplete"
      className="absolute bottom-full left-2 z-20 mb-1 max-h-56 w-60 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {suggestions.map((member, index) => (
        <li key={member.userId}>
          <button
            type="button"
            data-testid={`mention-option-${member.username}`}
            data-active={index === activeIndex}
            // mousedown (not click) so the textarea keeps focus through the selection.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(member);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm",
              index === activeIndex && "bg-accent text-accent-foreground",
            )}
          >
            <span className="shrink-0 font-medium" style={{ color: member.color }}>
              {member.displayName}
            </span>
            {member.marketIcon === undefined ? null : (
              <MarketIcon
                serverId={serverId}
                itemId={member.marketIcon.itemId}
                name={member.marketIcon.name}
              />
            )}
            <span className="truncate text-xs text-muted-foreground">@{member.username}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
