import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageLimits,
  UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import {
  resolvePresentationsWithUsageLimitsCache,
  type LimitPresentations,
  type UsageLimitsCache,
} from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

export const USAGE_LIMITS_CACHE_STORAGE_KEY = "t3.usageLimitsCache.v1";

const CachedProviderUsageSnapshotSchema = Schema.Struct({
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  accentColor: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  limits: ServerProviderUsageLimits,
});

const CachedHubUsageSourceSnapshotSchema = Schema.Struct({
  id: UsageLimitSourceId,
  label: Schema.String,
  kind: Schema.Literals(["cliproxy", "http"]),
  endpoint: Schema.optional(Schema.String),
  checkedAt: IsoDateTime,
  accounts: Schema.Record(Schema.String, UsageLimitSourceAccount),
});

const CachedEnvironmentUsageLimitsSchema = Schema.Struct({
  providers: Schema.Record(Schema.String, CachedProviderUsageSnapshotSchema),
  hubSources: Schema.optional(Schema.Record(Schema.String, CachedHubUsageSourceSnapshotSchema)),
});

const UsageLimitsCacheSchema = Schema.Record(Schema.String, CachedEnvironmentUsageLimitsSchema);
const decodeUsageLimitsCache = Schema.decodeUnknownOption(UsageLimitsCacheSchema);

function getSafeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readUsageLimitsCache(storage: Storage | null = getSafeLocalStorage()): UsageLimitsCache {
  if (!storage) return {};
  try {
    const raw = storage.getItem(USAGE_LIMITS_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = decodeUsageLimitsCache(JSON.parse(raw));
    return Option.isSome(parsed) ? parsed.value : {};
  } catch {
    return {};
  }
}

function writeUsageLimitsCache(
  cache: UsageLimitsCache,
  storage: Storage | null = getSafeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(USAGE_LIMITS_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage quota or privacy mode must not disrupt rendering usage limits.
  }
}

export function createPresentationsWithCachedLimitsAtom({
  presentationsAtom,
  isCatalogReadyAtom,
  storage,
}: {
  readonly presentationsAtom: Atom.Atom<LimitPresentations>;
  readonly isCatalogReadyAtom: Atom.Atom<boolean>;
  readonly storage?: Storage | null;
}): Atom.Atom<LimitPresentations> {
  let cache = readUsageLimitsCache(storage);
  return Atom.make((get) => {
    const presentations = get(presentationsAtom);
    const pruneMissingEnvironments = get(isCatalogReadyAtom);
    const reconciled = resolvePresentationsWithUsageLimitsCache(presentations, cache, {
      pruneMissingEnvironments,
    });
    if (reconciled.changed) {
      cache = reconciled.nextCache;
      writeUsageLimitsCache(cache, storage);
    }
    return reconciled.presentations;
  }).pipe(Atom.withLabel("web-presentations-with-cached-limits"));
}
