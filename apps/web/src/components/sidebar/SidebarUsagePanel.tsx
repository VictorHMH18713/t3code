import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { useLocation } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { msg, useGT, useMessages } from "gt-react";
import { ChartNoAxesColumnIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useUsage } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";
import {
  COMPACT_QUOTA_VIEWS,
  makeCompactUsageWindow,
  selectCompactProviderGroups,
  type CompactLimitRow,
  type CompactProviderGroup,
  type CompactQuotaView,
} from "./SidebarUsagePanel.logic";

const COLLAPSED_STORAGE_KEY = "t3code:sidebar-usage-panel-collapsed:v1";
const VIEW_STORAGE_KEY = "t3code:sidebar-usage-panel-quota-view:v1";
const CollapsedSchema = Schema.Boolean;
const ViewSchema = Schema.Literals(["5h", "7d", "all"]);
const LIVE_USAGE_REFRESH_INTERVAL_MS = 30_000;

const PACE_COPY = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
} as const;

const VIEW_LABEL: Record<CompactQuotaView, string> = {
  "5h": "5h",
  "7d": "7d",
  all: "All",
};

function CompactLimitBar({ row, now }: { readonly row: CompactLimitRow; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const fillColor =
    row.tone === "error"
      ? "var(--error)"
      : row.tone === "warning"
        ? "var(--warning)"
        : barColor(row.driver);
  const resetText =
    row.resetsAt && row.nextResetAt && row.nextResetAt > now
      ? gt("Resets in {duration} · {time}", {
          duration: formatDuration(row.nextResetAt - now, m),
          time: formatUpcomingTimestamp(row.resetsAt, timestampFormat, now, undefined, m),
        })
      : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            aria-label={gt("{provider} {window}: {remaining}% left", {
              provider: row.providerLabel,
              window: row.windowLabel,
              remaining: row.remainingPercent,
            })}
            className="grid w-full cursor-default grid-cols-[minmax(0,1fr)_3.75rem_2.1rem] items-center gap-2 rounded-md px-1 py-0.5 text-left text-2xs"
          />
        }
      >
        <span className="truncate text-sidebar-muted-foreground">{row.shortWindowLabel}</span>
        <span className="relative h-[3px] overflow-hidden rounded-full bg-sidebar-muted-foreground/25">
          {row.remainingPercent > 0 ? (
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `max(${row.remainingPercent}%, 4px)`,
                backgroundColor: fillColor,
              }}
            />
          ) : null}
        </span>
        <span
          className={cn(
            "text-end font-medium tabular-nums",
            row.tone === "error"
              ? "text-error-foreground"
              : row.tone === "warning"
                ? "text-warning-foreground"
                : "text-sidebar-foreground/85",
          )}
        >
          {row.remainingPercent}%
        </span>
      </TooltipTrigger>
      <TooltipPopup side="right" sideOffset={8}>
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="text-foreground">
            {row.accountsCount > 1
              ? gt("{provider} {window}: {remaining}% left ({accounts} accounts)", {
                  provider: row.providerLabel,
                  window: row.windowLabel,
                  remaining: row.remainingPercent,
                  accounts: row.accountsCount,
                })
              : gt("{provider} {window}: {remaining}% left", {
                  provider: row.providerLabel,
                  window: row.windowLabel,
                  remaining: row.remainingPercent,
                })}
          </span>
          {row.pace ? (
            <span className="text-muted-foreground">{m(PACE_COPY[row.pace])}</span>
          ) : null}
          {resetText ? <span className="text-muted-foreground">{resetText}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function ProviderQuotaGroup({
  group,
  now,
  statsPeriodLabel,
}: {
  readonly group: CompactProviderGroup;
  readonly now: number;
  readonly statsPeriodLabel: string;
}) {
  const gt = useGT();
  const color = barColor(group.driver);
  const tokensText = group.metrics ? formatTokens(group.metrics.totalTokens) : null;
  const cacheText =
    group.metrics && group.metrics.cacheHitRate !== null
      ? formatPercent(group.metrics.cacheHitRate, 0)
      : null;
  const cachePreciseText =
    group.metrics && group.metrics.cacheHitRate !== null
      ? formatPercent(group.metrics.cacheHitRate, 1)
      : null;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2 px-1 pt-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="truncate text-2xs font-medium text-sidebar-foreground">
            {group.shortProviderLabel}
          </span>
        </div>
        {tokensText ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 cursor-default text-3xs text-sidebar-muted-foreground tabular-nums" />
              }
            >
              {cacheText ? `${tokensText} · ${cacheText}` : tokensText}
            </TooltipTrigger>
            <TooltipPopup side="right" sideOffset={8}>
              <div className="flex flex-col gap-0.5 text-xs">
                <span className="text-foreground">
                  {gt("{provider} ({period}): {tokens} tokens", {
                    provider: group.providerLabel,
                    period: statsPeriodLabel,
                    tokens: tokensText,
                  })}
                </span>
                {cachePreciseText ? (
                  <span className="text-muted-foreground">
                    {gt("Cache hit rate: {rate}", { rate: cachePreciseText })}
                  </span>
                ) : null}
              </div>
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {group.rows.map((row) => (
        <CompactLimitBar key={row.key} row={row} now={now} />
      ))}
    </div>
  );
}

export const SidebarUsagePanel = memo(function SidebarUsagePanel() {
  const gt = useGT();
  const isOnUsagePage = useLocation({
    select: (location) => location.pathname === "/usage",
  });
  const [collapsed, setCollapsed] = useLocalStorage(COLLAPSED_STORAGE_KEY, false, CollapsedSchema);
  const [view, setView] = useLocalStorage<CompactQuotaView, CompactQuotaView>(
    VIEW_STORAGE_KEY,
    "all",
    ViewSchema,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const [windowState, setWindowState] = useState(() => ({
    minute: nowMinute,
    view,
    window: makeCompactUsageWindow(view, new Date(now)),
  }));
  let usageWindow = windowState.window;
  if (windowState.minute !== nowMinute || windowState.view !== view) {
    usageWindow = makeCompactUsageWindow(view, new Date(now));
    setWindowState({ minute: nowMinute, view, window: usageWindow });
  }

  const { merged: answeredUsage, environments, shown, refresh } = useUsage(usageWindow);
  const merged = shown?.merged ?? answeredUsage;
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const hasConnectedEnvironment = environments.some((env) => env.isConnected);
  const canReadDiagnostics = environments.some((env) => env.canReadDiagnostics);
  const groups = selectCompactProviderGroups(presentationsWithProviders, merged, now, view);
  const statsPeriodLabel = view === "7d" ? "7d" : "5h";

  const runRefresh = (automatic: boolean) => {
    if (refreshingRef.current) return;
    if (!hasConnectedEnvironment) return;
    refreshingRef.current = true;
    if (!automatic) setIsRefreshing(true);

    const nextWindow = makeCompactUsageWindow(view, new Date());
    const tasks: Array<Promise<unknown>> = [];
    if (canReadDiagnostics) {
      tasks.push(refresh(nextWindow));
    }
    for (const [environmentId, presentation] of presentationsWithProviders) {
      if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
        tasks.push(
          refreshUsageLimits(
            environmentId,
            () => refreshProviders({ environmentId, input: {} }),
            automatic,
          ),
        );
      }
    }

    void settlePromise(() => Promise.all(tasks)).finally(() => {
      refreshingRef.current = false;
      if (!automatic) setIsRefreshing(false);
    });
  };

  useLiveRefresh(() => runRefresh(true), {
    enabled: hasConnectedEnvironment && !isOnUsagePage,
    key: `sidebar-live-usage:${view}`,
    intervalMs: LIVE_USAGE_REFRESH_INTERVAL_MS,
  });

  if (environments.length === 0) return null;

  const collapsedSummary = groups
    .flatMap((group) => {
      const firstRow = group.rows[0];
      if (firstRow) return [`${group.shortProviderLabel} ${firstRow.remainingPercent}%`];
      if (group.metrics) {
        return [`${group.shortProviderLabel} ${formatTokens(group.metrics.totalTokens)}`];
      }
      return [];
    })
    .slice(0, 3)
    .join(" · ");

  if (collapsed) {
    return (
      <TooltipProvider delay={150} closeDelay={100}>
        <div
          data-sidebar-usage-panel="collapsed"
          className="flex h-7 items-center gap-1 rounded-lg border border-sidebar-border/70 bg-sidebar-control-surface/65 px-2 text-2xs text-sidebar-foreground select-none"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <ChartNoAxesColumnIcon
              aria-hidden
              className="size-3 shrink-0 text-sidebar-muted-foreground"
            />
            <span className="shrink-0 text-3xs text-sidebar-muted-foreground">
              {VIEW_LABEL[view]}
            </span>
            <span className="truncate font-medium tabular-nums">
              {collapsedSummary || gt("Usage")}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setCollapsed(false)}
                  aria-label={gt("Expand live usage panel")}
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              <ChevronUpIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">{gt("Expand live usage")}</TooltipPopup>
          </Tooltip>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delay={150} closeDelay={100}>
      <section
        aria-label={gt("Live usage summary")}
        data-sidebar-usage-panel="expanded"
        className="flex flex-col gap-1.5 rounded-lg border border-sidebar-border/75 bg-sidebar-control-surface/65 px-2 py-1.5 text-xs text-sidebar-foreground select-none"
      >
        <div className="flex items-center gap-1">
          <span
            aria-hidden
            className={cn(
              "ms-1 size-1.5 shrink-0 rounded-full",
              hasConnectedEnvironment ? "bg-success" : "bg-sidebar-muted-foreground/50",
            )}
          />
          <div
            role="group"
            aria-label={gt("Quota window")}
            className="flex items-center gap-0.5 rounded-md bg-sidebar-row-hover/60 p-0.5"
          >
            {COMPACT_QUOTA_VIEWS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={cn(
                  "cursor-pointer rounded px-1.5 py-0.5 text-3xs leading-none font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  view === option
                    ? "bg-background text-foreground shadow-xs"
                    : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
                )}
              >
                {VIEW_LABEL[option]}
              </button>
            ))}
          </div>
          <div className="ms-auto flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => runRefresh(false)}
                    disabled={isRefreshing || !hasConnectedEnvironment}
                    aria-label={gt("Refresh live usage")}
                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
                  />
                }
              >
                <RefreshIcon size="xs" refreshing={isRefreshing} />
              </TooltipTrigger>
              <TooltipPopup side="top">{gt("Refresh usage")}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setCollapsed(true)}
                    aria-label={gt("Collapse live usage panel")}
                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <ChevronDownIcon aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">{gt("Collapse to compact bar")}</TooltipPopup>
            </Tooltip>
          </div>
        </div>

        {groups.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {groups.map((group) => (
              <ProviderQuotaGroup
                key={group.driver}
                group={group}
                now={now}
                statsPeriodLabel={statsPeriodLabel}
              />
            ))}
          </div>
        ) : (
          <div className="px-1 py-1 text-left text-2xs text-sidebar-muted-foreground">
            {gt("No quota data for this window")}
          </div>
        )}
      </section>
    </TooltipProvider>
  );
});
