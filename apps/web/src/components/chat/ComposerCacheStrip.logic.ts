import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ServerProvider,
} from "@t3tools/contracts";

import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

export interface ThreadAgentCacheStat {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly shortLabel: string;
  readonly fullLabel: string;
  readonly totalInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly turnsWithCache: number;
  readonly hitRate: number;
  readonly latestHitRate: number | null;
  readonly isActive: boolean;
  readonly isCacheDrop: boolean;
}

const SHORT_DRIVER_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  grok: "Grok",
  muse: "Muse",
};

function driverFullLabel(driver: ProviderDriverKind): string {
  const presentation = Object.values(PROVIDER_PRESENTATION).find(
    (entry) => entry.driverKind === driver,
  );
  return presentation?.label ?? String(driver);
}

function driverShortLabel(driver: ProviderDriverKind): string {
  return SHORT_DRIVER_LABELS[String(driver)] ?? driverFullLabel(driver);
}

function resolveLabels(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "displayName">>,
): { readonly shortLabel: string; readonly fullLabel: string } {
  const matched = providers.find((provider) => provider.instanceId === instanceId);
  const fullFallback = driverFullLabel(driver);
  const shortFallback = driverShortLabel(driver);
  const customName = matched?.displayName?.trim();
  if (!customName || customName === fullFallback || customName === shortFallback) {
    return { shortLabel: shortFallback, fullLabel: fullFallback };
  }
  return { shortLabel: customName, fullLabel: `${customName} (${fullFallback})` };
}

interface TurnCacheSample {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
}

function extractTurnCacheSample(
  turn: Pick<OrchestrationV2ProviderTurn, "turnTokenUsage" | "tokenUsage">,
): TurnCacheSample | null {
  const finalUsage = turn.turnTokenUsage;
  if (
    finalUsage !== undefined &&
    finalUsage.inputTokens !== undefined &&
    finalUsage.inputTokens > 0 &&
    finalUsage.cachedInputTokens !== undefined
  ) {
    const inputTokens = finalUsage.inputTokens;
    const cachedInputTokens = Math.min(inputTokens, Math.max(0, finalUsage.cachedInputTokens));
    return {
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens: Math.max(0, finalUsage.cacheCreationTokens ?? 0),
    };
  }

  const liveUsage = turn.tokenUsage;
  if (
    liveUsage !== undefined &&
    liveUsage.inputTokens !== undefined &&
    liveUsage.inputTokens > 0 &&
    liveUsage.cachedInputTokens !== undefined
  ) {
    const inputTokens = Math.max(liveUsage.inputTokens, liveUsage.cachedInputTokens);
    const cachedInputTokens = Math.min(inputTokens, Math.max(0, liveUsage.cachedInputTokens));
    return {
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens: 0,
    };
  }

  return null;
}

function extractContextFallbackSample(
  providerThread: Pick<OrchestrationV2ProviderThread, "contextUsage">,
): TurnCacheSample | null {
  const usage = providerThread.contextUsage;
  if (!usage) return null;
  const rawInput = usage.inputTokens ?? usage.lastInputTokens;
  const rawCached = usage.cachedInputTokens ?? usage.lastCachedInputTokens;
  if (rawInput === undefined || rawInput <= 0 || rawCached === undefined) return null;
  const inputTokens = Math.max(rawInput, rawCached);
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, Math.max(0, rawCached)),
    cacheCreationTokens: 0,
  };
}

/**
 * Computes per-agent prompt-cache hit rates across all turns in a thread.
 * Multiple provider threads belonging to the same provider instance are merged in order of first use.
 */
export function deriveThreadAgentCacheStats(input: {
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "driver" | "providerInstanceId" | "contextUsage">
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderTurn,
      "providerThreadId" | "ordinal" | "turnTokenUsage" | "tokenUsage" | "promptDropped"
    >
  >;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "displayName">>;
  readonly activeProviderThreadId?: ProviderThreadId | null;
}): readonly ThreadAgentCacheStat[] {
  const threadById = new Map(input.providerThreads.map((thread) => [thread.id, thread] as const));
  const activeInstanceId =
    input.activeProviderThreadId != null
      ? (threadById.get(input.activeProviderThreadId)?.providerInstanceId ?? null)
      : null;

  interface Accumulator {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    totalInputTokens: number;
    cachedInputTokens: number;
    cacheCreationTokens: number;
    turnsWithCache: number;
    latestHitRate: number | null;
  }

  const byInstance = new Map<ProviderInstanceId, Accumulator>();
  const threadsWithTurnSamples = new Set<ProviderThreadId>();

  const sortedTurns = input.providerTurns.toSorted((left, right) => left.ordinal - right.ordinal);

  for (const turn of sortedTurns) {
    if (turn.promptDropped === true) continue;
    const providerThread = threadById.get(turn.providerThreadId);
    if (!providerThread) continue;
    const sample = extractTurnCacheSample(turn);
    if (!sample) continue;

    threadsWithTurnSamples.add(providerThread.id);
    const existing = byInstance.get(providerThread.providerInstanceId) ?? {
      instanceId: providerThread.providerInstanceId,
      driver: providerThread.driver,
      totalInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      turnsWithCache: 0,
      latestHitRate: null,
    };
    existing.totalInputTokens += sample.inputTokens;
    existing.cachedInputTokens += sample.cachedInputTokens;
    existing.cacheCreationTokens += sample.cacheCreationTokens;
    existing.turnsWithCache += 1;
    existing.latestHitRate = sample.cachedInputTokens / sample.inputTokens;
    byInstance.set(providerThread.providerInstanceId, existing);
  }

  // Fallback for providers that only report thread-level contextUsage without per-turn cache counters.
  for (const providerThread of input.providerThreads) {
    if (threadsWithTurnSamples.has(providerThread.id)) continue;
    const sample = extractContextFallbackSample(providerThread);
    if (!sample) continue;

    const existing = byInstance.get(providerThread.providerInstanceId) ?? {
      instanceId: providerThread.providerInstanceId,
      driver: providerThread.driver,
      totalInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      turnsWithCache: 0,
      latestHitRate: null,
    };
    existing.totalInputTokens += sample.inputTokens;
    existing.cachedInputTokens += sample.cachedInputTokens;
    existing.turnsWithCache += 1;
    existing.latestHitRate = sample.cachedInputTokens / sample.inputTokens;
    byInstance.set(providerThread.providerInstanceId, existing);
  }

  return [...byInstance.values()]
    .filter((entry) => entry.totalInputTokens > 0)
    .map((entry) => {
      const { shortLabel, fullLabel } = resolveLabels(
        entry.driver,
        entry.instanceId,
        input.providers,
      );
      const hitRate = Math.max(0, Math.min(1, entry.cachedInputTokens / entry.totalInputTokens));
      return {
        instanceId: entry.instanceId,
        driver: entry.driver,
        shortLabel,
        fullLabel,
        totalInputTokens: entry.totalInputTokens,
        cachedInputTokens: entry.cachedInputTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        turnsWithCache: entry.turnsWithCache,
        hitRate,
        latestHitRate: entry.latestHitRate,
        isActive: entry.instanceId === activeInstanceId,
        isCacheDrop:
          entry.turnsWithCache >= 2 && entry.latestHitRate !== null && entry.latestHitRate < 0.5,
      };
    });
}
