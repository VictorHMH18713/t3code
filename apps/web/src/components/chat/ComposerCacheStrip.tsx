import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import { useGT } from "gt-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";
import type { ThreadAgentCacheStat } from "./ComposerCacheStrip.logic";

export const ComposerCacheStrip = memo(function ComposerCacheStrip({
  entries,
  hasContextRowAbove = false,
}: {
  readonly entries: readonly ThreadAgentCacheStat[];
  readonly hasContextRowAbove?: boolean;
}) {
  const gt = useGT();
  if (entries.length === 0) return null;

  return (
    <TooltipProvider delay={150} closeDelay={100}>
      <div
        data-composer-cache-strip="true"
        aria-label={gt("Thread prompt cache hit rate")}
        className={cn(
          "surface-glass flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 text-2xs text-muted-foreground select-none",
          hasContextRowAbove ? "pt-1" : "pt-2",
        )}
      >
        <span className="shrink-0 text-3xs text-muted-foreground/80">{gt("Cache")}</span>
        {entries.map((entry) => {
          const hitText = formatPercent(entry.hitRate, 0);
          const preciseHitText = formatPercent(entry.hitRate, 1);
          const latestHitText =
            entry.latestHitRate !== null ? formatPercent(entry.latestHitRate, 1) : null;
          return (
            <Tooltip key={entry.instanceId}>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "inline-flex cursor-default items-center gap-1.5 tabular-nums",
                      entry.isActive && "text-foreground/85",
                    )}
                  />
                }
              >
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: barColor(entry.driver) }}
                />
                <span className="max-w-28 truncate">{entry.shortLabel}</span>
                <span
                  className={cn(
                    "font-medium",
                    entry.isCacheDrop
                      ? "text-warning-foreground"
                      : entry.isActive
                        ? "text-foreground"
                        : "text-foreground/80",
                  )}
                >
                  {hitText}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top" sideOffset={6}>
                <div className="flex flex-col gap-0.5 text-xs">
                  <span className="text-foreground">
                    {gt("{agent}: {rate} cache hit", {
                      agent: entry.fullLabel,
                      rate: preciseHitText,
                    })}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {gt("{cached} cached / {input} input ({turns} turns)", {
                      cached: formatTokens(entry.cachedInputTokens),
                      input: formatTokens(entry.totalInputTokens),
                      turns: entry.turnsWithCache,
                    })}
                  </span>
                  {entry.turnsWithCache > 1 && latestHitText ? (
                    <span className="text-muted-foreground tabular-nums">
                      {gt("Latest turn: {rate}", { rate: latestHitText })}
                    </span>
                  ) : null}
                  {entry.cacheCreationTokens > 0 ? (
                    <span className="text-muted-foreground tabular-nums">
                      {gt("Cache write: {tokens}", {
                        tokens: formatTokens(entry.cacheCreationTokens),
                      })}
                    </span>
                  ) : null}
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
});
