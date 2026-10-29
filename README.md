# @dre44/dyncache

A typed, synchronous cache with TTL, complex keys, tags, capacity limits, and
deduplicated asynchronous loading.

## Installation

```sh
pnpm add @dre44/dyncache
```

## Quick start

```ts
import { DynCache } from "@dre44/dyncache";

type User = { id: string; name: string };

const users = new DynCache<string, User>({
    entryOptions: { ttl: 60_000 },
    maxEntries: 1_000,
});

users.set("user:1", { id: "1", name: "Ada" });
users.get("user:1"); // User | undefined
users.has("user:1"); // true
users.getOrSet("user:2", () => ({ id: "2", name: "Grace" }));

users.remove("user:1");
users.deactivate(); // Stop scheduled cleanup and clear entries.
```

Keys can be strings, numbers, arrays, or objects. Keys are hashed with
`stable-hash`, so equivalent plain-object keys address the same entry:

```ts
const pages = new DynCache<{ path: string; locale: string }, string>({
    clearIntervalLength: 0,
});

pages.set({ path: "/about", locale: "en" }, "<h1>About</h1>");
pages.get({ path: "/about", locale: "en" }); // "<h1>About</h1>"
```

## Load a missing value once

`lock(key, fn)` returns a cached value or loads and caches it. Concurrent calls
for the same key share one promise and only run the first factory.

```ts
const settings = new DynCache<string, string>({
    entryOptions: { ttl: 60_000 },
});

async function loadSettings(): Promise<string> {
    const response = await fetch("https://example.com/settings.json");
    if (!response.ok) {
        throw new Error(`Failed to load settings: ${response.status}`);
    }
    return response.text();
}

const [first, second] = await Promise.all([
    settings.lock("settings", loadSettings),
    settings.lock("settings", loadSettings),
]); // One request; both callers receive the result.

const current = await settings.lockGet("settings");

// Reload even if cached; still share any active load.
const refreshed = await settings.lock("settings", loadSettings, { noRead: true });
```

- `lockGet` waits for active loads, then reads the cache. It never starts a load.
- `get` and `has` remain synchronous and do not wait for locks.
- Load or write errors reject the promise and release the lock for retries.
- Explicit `set`, `remove`, and `clear` prevent pending loads from caching stale
  results. They do not cancel the external work or its result for existing callers.
- Locks coordinate one cache instance, not multiple processes. Factories must
  not await their own key's lock.

Use `getOrSet` for synchronous factories and `lock` for asynchronous loading.
See [detailed lock behavior](docs/dyn-cache.md#deduplicating-asynchronous-retrievals).

## TTL and tags

Set defaults through `entryOptions`, then override them per entry:

```ts
const sessions = new DynCache<string, string>({
    entryOptions: { ttl: 60_000 },
});

sessions.set("session:1", "active", {
    ttl: 30_000,
    refresh: true,
    tags: ["session", "user:1"],
});

sessions.get("session:1"); // Refresh the TTL.
sessions.get("session:1", { refresh: false }); // Read without refreshing.

sessions.find({ someTag: ["user:1"] });
sessions.find({ keys: ["session:1"] });
sessions.find((entry) => entry.value === "active");
sessions.removeByFinder({ someTag: ["user:1"] });
```

`ttl` defaults to `Infinity`; `0` and `Infinity` disable expiration, not caching.
`refresh` defaults to `false`. Expired entries are removed on retrieval and by
scheduled cleanup. `has` also uses the retrieval path and can refresh TTL.
Finders return complete entries, not just values.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `entryOptions` | `{}` | Default `ttl`, `refresh`, and `tags`. |
| `engine` | `new MemoryEngine()` | Synchronous storage engine. |
| `maxSize` | `Infinity` | Maximum total recorded entry size in bytes. |
| `maxEntrySize` | `maxSize` or `Infinity` | Maximum size of one entry in bytes. |
| `maxEntries` | `Infinity` | Entry limit; `0` or `Infinity` disables it. |
| `clearIntervalLength` | `300000` | Cleanup interval in milliseconds; `0` or `Infinity` disables it. |
| `startClearInterval` | `setInterval` | Custom scheduler: `(intervalLength, clear, abortSignal)`. Stop when aborted. |
| `onSet` | None | Synchronous callback: `(entry, previousEntry)`. |
| `onRemove` | None | Synchronous callback for removal, replacement, expiry, eviction, or clearing. |

When capacity is exceeded, expired entries are removed first, then entries with
the earliest expiration are evicted. Ties preserve engine order; this is not LRU.
Sizes include entry metadata, are calculated at insertion with `object-sizeof`,
and are not updated when stored objects are mutated.

Negative limits and `maxEntrySize > maxSize` are rejected. Oversized entries
throw before replacing an existing entry.

## Additional methods

| Method | Result |
| --- | --- |
| `getEntry(key, options?)` | Entry metadata and value, or `undefined`. |
| `all()` | All live entries; removes expired ones. |
| `getSize()` | Recorded total size in bytes. |
| `getLength()` | Recorded entry count. |
| `clear()` | Remove entries and invalidate pending writes; keep cleanup running. |
| `deactivate()` | Stop cleanup, clear entries, and invalidate pending writes. |
| `deactivate(true)` | Stop cleanup; retain entries and pending writes. |

Size and count do not trigger expiry cleanup. The built-in timer does not keep
Node.js running where timer `unref` is supported.

## Custom engines

Implement the exported `DynCacheEngine<K, V>` interface with synchronous
`getValue`, `setValue`, `allKeys`, and `removeValue` methods. Engines store complete
`DynCacheEntry<K, V>` objects under the hashed string keys supplied by the cache.
Asynchronous loading belongs in a `lock` factory, not in the engine.
