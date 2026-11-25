import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadAgentCacheStats } from "./ComposerCacheStrip.logic";

type ThreadInput = Pick<
  OrchestrationV2ProviderThread,
  "id" | "driver" | "providerInstanceId" | "contextUsage"
>;
type TurnInput = Pick<
  OrchestrationV2ProviderTurn,
  "providerThreadId" | "ordinal" | "turnTokenUsage" | "tokenUsage" | "promptDropped"
>;

describe("ComposerCacheStrip.logic", () => {
  it("aggregates multi-turn cache hit rates per agent and merges repeated segments", () => {
    const claudeThread1 = ProviderThreadId.make("pt-claude-1");
    const codexThread = ProviderThreadId.make("pt-codex-1");
    const claudeThread2 = ProviderThreadId.make("pt-claude-2");
    const claudeInstance = ProviderInstanceId.make("claude-main");
    const codexInstance = ProviderInstanceId.make("codex-main");

    const providerThreads: ThreadInput[] = [
      {
        id: claudeThread1,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeInstance,
        contextUsage: null,
      },
      {
        id: codexThread,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstance,
        contextUsage: null,
      },
      {
        id: claudeThread2,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeInstance,
        contextUsage: null,
      },
    ];

    const providerTurns: TurnInput[] = [
      {
        providerThreadId: claudeThread1,
        ordinal: 1,
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 1000,
          cachedInputTokens: 800,
          cacheCreationTokens: 100,
          outputTokens: 200,
          hasSubagents: false,
        },
      },
      {
        providerThreadId: codexThread,
        ordinal: 2,
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 2000,
          cachedInputTokens: 1500,
          outputTokens: 300,
          hasSubagents: false,
        },
      },
      {
        providerThreadId: claudeThread2,
        ordinal: 3,
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 1000,
          cachedInputTokens: 960,
          cacheCreationTokens: 20,
          outputTokens: 150,
          hasSubagents: false,
        },
      },
      {
        providerThreadId: claudeThread2,
        ordinal: 4,
        promptDropped: true,
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 5000,
          cachedInputTokens: 0,
          outputTokens: 0,
          hasSubagents: false,
        },
      },
    ];

    const stats = deriveThreadAgentCacheStats({
      providerThreads,
      providerTurns,
      providers: [],
      activeProviderThreadId: claudeThread2,
    });

    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      shortLabel: "Claude",
      totalInputTokens: 2000,
      cachedInputTokens: 1760,
      cacheCreationTokens: 120,
      turnsWithCache: 2,
      isActive: true,
      isCacheDrop: false,
    });
    expect(stats[0]?.hitRate).toBeCloseTo(0.88, 6);
    expect(stats[0]?.latestHitRate).toBeCloseTo(0.96, 6);

    expect(stats[1]).toMatchObject({
      shortLabel: "Codex",
      totalInputTokens: 2000,
      cachedInputTokens: 1500,
      turnsWithCache: 1,
      isActive: false,
      isCacheDrop: false,
    });
    expect(stats[1]?.hitRate).toBeCloseTo(0.75, 6);
  });

  it("falls back to live tokenUsage and contextUsage and flags late cache drops", () => {
    const agThread = ProviderThreadId.make("pt-ag-1");
    const agInstance = ProviderInstanceId.make("ag-main");
    const cursorThread = ProviderThreadId.make("pt-cursor-1");
    const cursorInstance = ProviderInstanceId.make("cursor-main");

    const stats = deriveThreadAgentCacheStats({
      providerThreads: [
        {
          id: agThread,
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: agInstance,
          contextUsage: null,
        },
        {
          id: cursorThread,
          driver: ProviderDriverKind.make("cursor"),
          providerInstanceId: cursorInstance,
          contextUsage: {
            usedTokens: 4000,
            inputTokens: 4000,
            cachedInputTokens: 3000,
          },
        },
      ],
      providerTurns: [
        {
          providerThreadId: agThread,
          ordinal: 1,
          tokenUsage: {
            usedTokens: 1000,
            inputTokens: 1000,
            cachedInputTokens: 900,
            updatedAt: "2026-11-25T00:00:00.000Z",
          },
        },
        {
          providerThreadId: agThread,
          ordinal: 2,
          tokenUsage: {
            usedTokens: 1000,
            inputTokens: 1000,
            cachedInputTokens: 200,
            updatedAt: "2026-11-25T00:01:00.000Z",
          },
        },
      ],
      providers: [
        {
          instanceId: agInstance,
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "AG Personal",
        },
      ],
      activeProviderThreadId: agThread,
    });

    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      shortLabel: "AG Personal",
      fullLabel: "AG Personal (Antigravity)",
      turnsWithCache: 2,
      isActive: true,
      isCacheDrop: true,
    });
    expect(stats[0]?.hitRate).toBeCloseTo(0.55, 6);
    expect(stats[0]?.latestHitRate).toBeCloseTo(0.2, 6);

    expect(stats[1]).toMatchObject({
      shortLabel: "Cursor",
      totalInputTokens: 4000,
      cachedInputTokens: 3000,
      turnsWithCache: 1,
    });
  });
});
