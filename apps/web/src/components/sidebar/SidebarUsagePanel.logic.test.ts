import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  compactLimitTone,
  computeProviderMetrics,
  makeCompactUsageWindow,
  selectCompactProviderGroups,
} from "./SidebarUsagePanel.logic";

function makeProvider(
  driver: ServerProvider["driver"],
  instanceId: string,
  email: string,
  windows: ServerProviderUsageLimits["windows"],
): ServerProvider {
  return {
    driver,
    instanceId: ProviderInstanceId.make(instanceId),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    checkedAt: "2026-11-25T00:00:00.000Z",
    auth: {
      status: "authenticated",
      email,
    },
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-25T00:00:00.000Z",
      windows,
    },
  };
}

describe("SidebarUsagePanel.logic", () => {
  it("builds 5h hourly windows for 5h/all and 7d daily window for 7d", () => {
    const now = new Date("2026-11-25T10:15:30.000Z");

    const fiveHour = makeCompactUsageWindow("5h", now);
    expect(fiveHour.resolution).toBe("hour");
    expect(fiveHour.sinceTime).toBe("2026-11-25T05:16:00.000Z");
    expect(fiveHour.untilTime).toBe("2026-11-25T10:16:00.000Z");

    const allWindow = makeCompactUsageWindow("all", now);
    expect(allWindow.resolution).toBe("hour");
    expect(allWindow.sinceTime).toBe("2026-11-25T05:16:00.000Z");

    const sevenDay = makeCompactUsageWindow("7d", now);
    expect(sevenDay.resolution).toBe("day");
    expect(sevenDay.sinceTime).toBeUndefined();
  });

  it("computes token totals and cache hit rate separately per provider", () => {
    const metrics = computeProviderMetrics({
      models: [
        {
          model: "claude-sonnet-4",
          provider: "claude",
          costUsd: 5,
          totalTokens: 1000,
          tokens: {
            uncachedInputTokens: 100,
            cachedInputTokens: 800,
            cacheCreationTokens: 100,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          records: 1,
          unpricedRecords: 0,
          unpricedTokens: 0,
          costShare: 0.5,
          tokenShare: 0.5,
        },
        {
          model: "gpt-5",
          provider: "codex",
          costUsd: 5,
          totalTokens: 500,
          tokens: {
            uncachedInputTokens: 250,
            cachedInputTokens: 250,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          records: 1,
          unpricedRecords: 0,
          unpricedTokens: 0,
          costShare: 0.5,
          tokenShare: 0.5,
        },
      ],
    });

    expect(metrics.get(ProviderDriverKind.make("claudeAgent"))).toEqual({
      totalTokens: 1000,
      cacheHitRate: 0.8,
    });
    expect(metrics.get(ProviderDriverKind.make("codex"))).toEqual({
      totalTokens: 500,
      cacheHitRate: 0.5,
    });
  });

  it("assigns warning and error tones at low remaining thresholds", () => {
    expect(compactLimitTone(8)).toBe("error");
    expect(compactLimitTone(10)).toBe("error");
    expect(compactLimitTone(15)).toBe("warning");
    expect(compactLimitTone(20)).toBe("warning");
    expect(compactLimitTone(55)).toBeNull();
  });

  it("groups windows by provider and filters cleanly between 5h, 7d, and all", () => {
    const now = Date.parse("2026-11-25T02:00:00.000Z");
    const presentations: LimitPresentations = new Map([
      [
        EnvironmentId.make("local"),
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              makeProvider(ProviderDriverKind.make("claudeAgent"), "claude-1", "a@example.com", [
                {
                  id: "five_hour",
                  kind: "session",
                  label: "Session",
                  usedPercent: 13,
                  resetsAt: "2026-11-25T05:00:00.000Z",
                },
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 25,
                  resetsAt: "2026-11-30T00:00:00.000Z",
                },
              ]),
              makeProvider(ProviderDriverKind.make("codex"), "codex-1", "b@example.com", [
                {
                  id: "secondary",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 65,
                  resetsAt: "2026-11-29T00:00:00.000Z",
                },
              ]),
              makeProvider(ProviderDriverKind.make("antigravity"), "ag-1", "c@example.com", [
                {
                  id: "gemini-5h",
                  kind: "session",
                  label: "Gemini · 5-hour",
                  usedPercent: 20,
                  resetsAt: "2026-11-25T06:00:00.000Z",
                },
                {
                  id: "3p-5h",
                  kind: "session",
                  label: "Claude & GPT (shared) · 5-hour",
                  usedPercent: 10,
                  resetsAt: "2026-11-25T06:00:00.000Z",
                },
              ]),
            ],
          },
        },
      ],
    ]);

    const allGroups = selectCompactProviderGroups(presentations, { models: [] }, now, "all");
    expect(allGroups.map((group) => group.shortProviderLabel)).toEqual([
      "Codex",
      "Claude",
      "Antigravity",
    ]);
    expect(allGroups[1]?.rows.map((row) => row.shortWindowLabel)).toEqual(["5h", "7d"]);
    expect(allGroups[2]?.rows.map((row) => row.shortWindowLabel)).toEqual(["Gemini 5h", "3P 5h"]);

    const fiveHourGroups = selectCompactProviderGroups(presentations, { models: [] }, now, "5h");
    expect(fiveHourGroups.map((group) => group.shortProviderLabel)).toEqual([
      "Claude",
      "Antigravity",
    ]);
    expect(fiveHourGroups[0]?.rows.map((row) => row.shortWindowLabel)).toEqual(["5h"]);

    const sevenDayGroups = selectCompactProviderGroups(presentations, { models: [] }, now, "7d");
    expect(sevenDayGroups.map((group) => group.shortProviderLabel)).toEqual(["Codex", "Claude"]);
    expect(sevenDayGroups[0]?.rows.map((row) => row.shortWindowLabel)).toEqual(["7d"]);
    expect(sevenDayGroups[1]?.rows.map((row) => row.shortWindowLabel)).toEqual(["7d"]);
  });
});
