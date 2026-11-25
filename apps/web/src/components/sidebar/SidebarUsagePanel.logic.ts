// @effect-diagnostics globalDate:off -- Usage windows are derived from wall-clock instants via Intl.
import {
  UsageDay,
  type ServerProvider,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  type LimitPace,
  type LimitPresentations,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import type { MergedUsage } from "@t3tools/shared/usageMerge";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "../usage/usageProviders";

export type CompactQuotaView = "5h" | "7d" | "all";
export type CompactUsageTone = "error" | "warning" | null;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export const COMPACT_QUOTA_VIEWS: readonly CompactQuotaView[] = ["5h", "7d", "all"];

export interface CompactLimitRow {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly kind: LimitPoolWindow["kind"];
  readonly providerLabel: string;
  readonly windowLabel: string;
  readonly shortWindowLabel: string;
  readonly remainingPercent: number;
  readonly tone: CompactUsageTone;
  readonly pace: LimitPace | null;
  readonly resetsAt: string | null;
  readonly nextResetAt: number | null;
  readonly accountsCount: number;
}

export interface ProviderUsageMetrics {
  readonly totalTokens: number;
  readonly cacheHitRate: number | null;
}

export interface CompactProviderGroup {
  readonly driver: ServerProvider["driver"];
  readonly providerLabel: string;
  readonly shortProviderLabel: string;
  readonly rows: readonly CompactLimitRow[];
  readonly metrics: ProviderUsageMetrics | null;
}

export function compactLimitTone(remainingPercent: number): CompactUsageTone {
  if (remainingPercent <= 10) return "error";
  if (remainingPercent <= 20) return "warning";
  return null;
}

function makeRollingHoursWindow(hours: number, now: Date): UsageSummaryInput {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // Align to the end of the current minute so records written in the current minute appear immediately.
  const untilTimeMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const sinceTimeMs = untilTimeMs - hours * HOUR_MS;
  const sinceTime = new Date(sinceTimeMs);
  const untilTime = new Date(untilTimeMs);
  return {
    sinceDay: UsageDay.make(format.format(sinceTime)),
    untilDay: UsageDay.make(format.format(untilTime)),
    timeZone,
    resolution: "hour",
    sinceTime: sinceTime.toISOString(),
    untilTime: untilTime.toISOString(),
  };
}

/**
 * Returns the transcript-usage window paired with each quota view:
 * `7d` queries 7 days; `5h` and `all` query the rolling 5-hour window.
 */
export function makeCompactUsageWindow(
  view: CompactQuotaView,
  now = new Date(),
): UsageSummaryInput {
  if (view === "7d") return makeWindow(7, now, "day");
  return makeRollingHoursWindow(5, now);
}

/**
 * Computes per-provider token totals and prompt-cache hit rate from merged model breakdowns.
 * Cache creation tokens count as misses because input was freshly processed.
 */
export function computeProviderMetrics(
  merged: Pick<MergedUsage, "models">,
): ReadonlyMap<ServerProvider["driver"], ProviderUsageMetrics> {
  const accum = new Map<
    UsageProviderKind,
    { totalTokens: number; cachedInput: number; totalInput: number }
  >();

  for (const model of merged.models) {
    const entry = accum.get(model.provider) ?? {
      totalTokens: 0,
      cachedInput: 0,
      totalInput: 0,
    };
    entry.totalTokens += model.totalTokens;
    entry.cachedInput += model.tokens.cachedInputTokens;
    entry.totalInput +=
      model.tokens.uncachedInputTokens +
      model.tokens.cachedInputTokens +
      model.tokens.cacheCreationTokens;
    accum.set(model.provider, entry);
  }

  const byDriver = new Map<ServerProvider["driver"], ProviderUsageMetrics>();
  for (const [providerKind, stats] of accum) {
    const driver = PROVIDER_PRESENTATION[providerKind].driverKind;
    byDriver.set(driver, {
      totalTokens: stats.totalTokens,
      cacheHitRate: stats.totalInput > 0 ? stats.cachedInput / stats.totalInput : null,
    });
  }
  return byDriver;
}

const SHORT_DRIVER_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  grok: "Grok",
  muse: "Muse",
};

const DRIVER_ORDER = new Map<string, number>(
  PROVIDER_ORDER.map((provider, index) => [
    String(PROVIDER_PRESENTATION[provider].driverKind),
    index,
  ]),
);

function driverRank(driver: ServerProvider["driver"]): number {
  return DRIVER_ORDER.get(String(driver)) ?? DRIVER_ORDER.size;
}

function driverLabel(driver: ServerProvider["driver"]): string {
  const presentation = Object.values(PROVIDER_PRESENTATION).find(
    (entry) => entry.driverKind === driver,
  );
  return presentation?.label ?? String(driver);
}

function shortDriverLabel(driver: ServerProvider["driver"]): string {
  return SHORT_DRIVER_LABELS[String(driver)] ?? driverLabel(driver);
}

function compactWindowLabel(window: LimitPoolWindow): string {
  const trimmed = window.label.trim();
  const normalized = trimmed.toLowerCase();
  if (window.kind === "session" && (normalized === "session" || normalized === "5-hour")) {
    return "5h";
  }
  if (window.kind === "weekly" && (normalized === "weekly" || normalized === "7-day")) {
    return "7d";
  }
  return trimmed
    .replace(/^Claude & GPT \(shared\)/i, "3P")
    .replace(/\s*·\s*5-hour$/i, " 5h")
    .replace(/\s*·\s*Weekly$/i, " 7d")
    .replace(/\s*·\s*Reported quota$/i, "");
}

function nextResetFromPoolWindow(
  window: LimitPoolWindow,
  now: number,
): { readonly at: number; readonly resetsAt: string | null } | null {
  const pooled = window.members.length > 1;
  const next = window.resets.find(
    (reset) => reset.at > now && (!pooled || reset.restoresPercent > 0),
  );
  if (!next) return null;
  return { at: next.at, resetsAt: next.member.window.resetsAt ?? null };
}

function toCompactRow(
  driver: ServerProvider["driver"],
  window: LimitPoolWindow,
  now: number,
): CompactLimitRow {
  const nextReset = nextResetFromPoolWindow(window, now);
  return {
    key: `${driver}:${window.id}`,
    driver,
    kind: window.kind,
    providerLabel: driverLabel(driver),
    windowLabel: window.label,
    shortWindowLabel: compactWindowLabel(window),
    remainingPercent: window.remainingPercent,
    tone: compactLimitTone(window.remainingPercent),
    pace: window.pace,
    resetsAt: nextReset?.resetsAt ?? null,
    nextResetAt: nextReset?.at ?? null,
    accountsCount: window.members.length,
  };
}

function matchesQuotaView(window: LimitPoolWindow, view: CompactQuotaView): boolean {
  if (view === "all") return true;
  if (view === "5h") return window.kind === "session" || window.kind === "other";
  return window.kind === "weekly" || window.kind === "monthly";
}

/**
 * Groups active provider quota windows by product so the same product's windows always stay
 * together, filtered by the selected quota view (`5h` | `7d` | `all`), and pairs each provider
 * with its own token & cache hit-rate stats (never mixed across providers).
 */
export function selectCompactProviderGroups(
  presentations: LimitPresentations,
  merged: Pick<MergedUsage, "models">,
  now: number,
  view: CompactQuotaView,
): readonly CompactProviderGroup[] {
  const accounts = collectLimitAccounts(presentations);
  const pools = collectLimitPools(accounts, now);
  const metricsByDriver = computeProviderMetrics(merged);

  const groupsByDriver = new Map<ServerProvider["driver"], CompactProviderGroup>();

  for (const pool of pools) {
    const rows = displayLimitWindows(pool)
      .filter((window) => matchesQuotaView(window, view))
      .map((window) => toCompactRow(pool.driver, window, now));
    const metrics = metricsByDriver.get(pool.driver) ?? null;
    if (rows.length === 0 && (metrics === null || metrics.totalTokens === 0)) continue;
    groupsByDriver.set(pool.driver, {
      driver: pool.driver,
      providerLabel: driverLabel(pool.driver),
      shortProviderLabel: shortDriverLabel(pool.driver),
      rows,
      metrics: metrics && metrics.totalTokens > 0 ? metrics : null,
    });
  }

  for (const [driver, metrics] of metricsByDriver) {
    if (metrics.totalTokens <= 0 || groupsByDriver.has(driver)) continue;
    groupsByDriver.set(driver, {
      driver,
      providerLabel: driverLabel(driver),
      shortProviderLabel: shortDriverLabel(driver),
      rows: [],
      metrics,
    });
  }

  return [...groupsByDriver.values()].toSorted(
    (left, right) =>
      Number(left.rows.length === 0) - Number(right.rows.length === 0) ||
      driverRank(left.driver) - driverRank(right.driver),
  );
}
