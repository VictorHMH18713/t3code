import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createPresentationsWithCachedLimitsAtom,
  USAGE_LIMITS_CACHE_STORAGE_KEY,
} from "./usageLimitsCache";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex-default"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    checkedAt: "2026-11-25T10:00:00.000Z",
    auth: {
      status: "authenticated",
      email: "user@example.com",
    },
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("usageLimitsCache", () => {
  it("persists fetched limits in storage and restores them after reload when a query fails", () => {
    const storage = createMemoryStorage();
    const envId = EnvironmentId.make("home-wsl2");
    const validLimits = {
      checkedAt: "2026-11-25T10:00:00.000Z",
      windows: [{ id: "five_hour", kind: "session", label: "5-hour", usedPercent: 28 }],
    } as const;

    const presentationsSource = Atom.make<LimitPresentations>(
      new Map([
        [
          envId,
          {
            entry: { target: { label: "home-wsl2" } },
            serverConfig: { providers: [makeProvider({ usageLimits: validLimits })] },
          },
        ],
      ]),
    );
    const catalogReady = Atom.make(true);

    const registry1 = AtomRegistry.make();
    const atom1 = createPresentationsWithCachedLimitsAtom({
      presentationsAtom: presentationsSource,
      isCatalogReadyAtom: catalogReady,
      storage,
    });
    expect(registry1.get(atom1).get(envId)?.serverConfig?.providers[0]?.usageLimits).toEqual(
      validLimits,
    );
    expect(storage.getItem(USAGE_LIMITS_CACHE_STORAGE_KEY)).not.toBeNull();

    // Simulate reload where the catalog is not ready yet and then server reports probeFailed.
    const reloadedPresentations = Atom.make<LimitPresentations>(new Map());
    const reloadedCatalogReady = Atom.make(false);
    const registry2 = AtomRegistry.make();
    const atom2 = createPresentationsWithCachedLimitsAtom({
      presentationsAtom: reloadedPresentations,
      isCatalogReadyAtom: reloadedCatalogReady,
      storage,
    });

    registry2.get(atom2);
    expect(storage.getItem(USAGE_LIMITS_CACHE_STORAGE_KEY)).toContain("five_hour");

    registry2.set(
      reloadedPresentations,
      new Map([
        [
          envId,
          {
            entry: { target: { label: "home-wsl2" } },
            serverConfig: {
              providers: [
                makeProvider({
                  status: "error",
                  auth: { status: "unknown" },
                  usageLimits: {
                    checkedAt: "2026-11-25T10:05:00.000Z",
                    windows: [],
                    unavailable: { reason: "probeFailed" },
                  },
                }),
              ],
            },
          },
        ],
      ]),
    );
    registry2.set(reloadedCatalogReady, true);

    const resolvedProvider = registry2.get(atom2).get(envId)?.serverConfig?.providers[0];
    expect(resolvedProvider?.usageLimits).toEqual(validLimits);
    expect(resolvedProvider?.auth.email).toBe("user@example.com");
  });
});
