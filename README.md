# @dre44/dyncache

A typed, synchronous cache with TTL, complex keys, tags, capacity limits, and
per-key deduplication for asynchronous data loading.

Use `DynCache` for normal cache operations and `lock` when multiple callers may
request the same uncached value at once. The cache engine stays synchronous;
only the loading API needs to be awaited.

## Installation

```sh
pnpm add @dre44/dyncache
```

## Quick start

```ts
import { DynCache } from "@dre44/dyncache";

type Project = { id: string; name: string };

const cache = new DynCache<string, Project>({
    entryOptions: { ttl: 60_000 },
    maxEntries: 1_000,
});

cache.set("project:1", { id: "1", name: "Example" });

const project = cache.get("project:1"); // Project | undefined
const exists = cache.has("project:1"); // boolean

cache.remove("project:1");
cache.deactivate(); // Stop scheduled cleanup and clear the cache.
```

Keys can also be numbers, arrays, or objects. Keys are hashed using `stable-hash`,
so equivalent plain-object keys can address the same entry:

```ts
const cache = new DynCache<{ id: string }, string>({
    clearIntervalLength: 0,
});

cache.set({ id: "1" }, "Example");
cache.get({ id: "1" }); // "Example"
```

## Load a missing value once

Use `lock(key, fn)` instead of separately checking, loading, and setting a value:

```ts
import { DynCache } from "@dre44/dyncache";

const cache = new DynCache<string, string>({
    entryOptions: { ttl: 60_000 },
});

async function loadProjectName(id: string): Promise<string> {
    const response = await fetch(`/api/projects/${id}/name`);
    if (!response.ok) {
        throw new Error(`Failed to load project name: ${response.status}`);
    }
    return response.text();
}

const first = cache.lock("project:1", () => loadProjectName("1"));
const second = cache.lock("project:1", () => loadProjectName("1"));

// Only the first factory runs. Both callers receive the loaded value.
const [a, b] = await Promise.all([first, second]);

// Wait for an active load, then read the current cached value.
const name = await cache.lockGet("project:1"); // string | undefined

cache.deactivate();
```

### Lock behavior

- On a cache hit, `lock` resolves with the cached value without calling the factory.
- On a miss, concurrent calls for the same hashed key share one promise and the
  first factory. Different keys can load independently.
- Factories may return a value or a promise. Loaded values are stored through
  `set`, using the configured entry defaults, size limits, and callbacks.
- `lockGet` waits for active loads and returns the current cache value. It never
  starts a load, and resolves to `undefined` when no entry exists.
- Normal `get` and `has` calls remain synchronous and do not wait for locks.
- Loading or cache-write errors reject the promise and release the lock so a
  later call can retry. Always await or handle returned promises.

Explicit `set`, `remove` (even for an absent key), and `clear` invalidate pending
cache writes for affected keys. External loading work is not cancelled: existing
`lock` callers still receive its result or error, but stale results are not cached.
Waiting `lockGet` callers read the current cache state after the load completes.

Locks apply to a single cache instance, not across processes. A factory must not
await its own key's lock, directly or through a dependency cycle.

## Synchronous get-or-set

For synchronous factories, `getOrSet` returns an existing value or computes and
caches a new one:

```ts
const cache = new DynCache<string, number>({ clearIntervalLength: 0 });

const count = cache.getOrSet("count", () => 42);
```

Use `lock` for asynchronous loading and deduplication, rather than passing an
async factory to `getOrSet`.

## TTL, refresh, and tags

Set defaults with `entryOptions`, and override them for individual entries:

```ts
const cache = new DynCache<string, string>({
    entryOptions: { ttl: 60_000 },
});

cache.set("session:1", "active", {
    ttl: 30_000,
    refresh: true,
    tags: ["session", "user:1"],
});

cache.get("session:1"); // Refreshes this entry's TTL.
cache.get("session:1", { refresh: false }); // Read without refreshing.
```

| Option | Default | Behavior |
| --- | --- | --- |
| `ttl` | `Infinity` | Lifetime in milliseconds. `0` and `Infinity` disable expiration, not caching. |
| `refresh` | `false` | Refresh the TTL on retrieval. A read's `refresh` option takes precedence. |
| `tags` | `[]` | Tags used to find or remove entries. |

Expired entries are removed on retrieval and by scheduled cleanup.
`has` uses the normal retrieval path, so it can also refresh TTL.

## Find and remove entries

Finders return cache entries, including their keys, values, tags, expiry
timestamps, and recorded sizes.

```ts
const cache = new DynCache<string, number>({ clearIntervalLength: 0 });

cache.set("project:1", 10, { tags: ["project", "active"] });
cache.set("project:2", 20, { tags: ["project", "archived"] });

const active = cache.find({ someTag: ["active"] });
const selected = cache.find({ keys: ["project:1", "project:2"] });
const large = cache.find((entry) => entry.value > 15);

cache.removeByFinder({ someTag: ["archived"] });
```

Object finder conditions are combined with AND. Use a predicate for custom
matching, such as requiring every requested tag:

```ts
const requiredTags = ["project", "active"];
const matching = cache.find((entry) =>
    requiredTags.every((tag) => entry.tags.includes(tag)),
);
```

## Configuration

Pass a `DynCacheConfig<K, V>` object to the constructor.

| Option | Default | Description |
| --- | --- | --- |
| `entryOptions` | `{}` | Default TTL, refresh, and tags for new entries. |
| `engine` | `new MemoryEngine()` | Synchronous storage engine. |
| `maxSize` | `Infinity` | Maximum total recorded entry size in bytes. |
| `maxEntrySize` | `maxSize` | Maximum size of one entry in bytes; defaults to `Infinity` when `maxSize` is unset. |
| `maxEntries` | `Infinity` | Maximum number of entries. `0` or `Infinity` disables the limit. |
| `clearIntervalLength` | `300000` | Expiry-cleanup interval in milliseconds. `0` or `Infinity` disables scheduled cleanup. |
| `startClearInterval` | Built-in `setInterval` | Custom scheduler receiving `(intervalLength, clear, abortSignal)`. Stop scheduling when the signal is aborted. |
| `onSet` | None | Synchronous callback receiving `(entry, previousEntry)`. |
| `onRemove` | None | Synchronous callback receiving the removed entry, including replacements, expiration, eviction, and clearing. |

When a new entry would exceed capacity, expired entries are removed first.
If more space is needed, entries with the earliest expiration are evicted first,
preserving engine order for ties. This is not an LRU cache.

Entry sizes are calculated at insertion using `object-sizeof`, including entry
metadata. They are not a measurement of process memory and are not recalculated
if a stored object is mutated.

Negative limits and a `maxEntrySize` greater than `maxSize` are rejected.
Entries exceeding `maxEntrySize` throw before replacing an existing entry.

## API reference

All methods are synchronous unless their return type is a promise.

| Method | Returns | Purpose |
| --- | --- | --- |
| `set(key, value, options?)` | `DynCacheEntry<K, V>` | Store or replace an entry. |
| `get(key, options?)` | `V \| undefined` | Read a value, removing it if expired. |
| `getEntry(key, options?)` | `DynCacheEntry<K, V> \| undefined` | Read the entry and its metadata. |
| `getOrSet(key, fn, getOptions?, setOptions?)` | `V` | Compute and cache a value synchronously on a miss. |
| `lock(key, fn)` | `Promise<Awaited<V>>` | Read or share one asynchronous load per key. |
| `lockGet(key)` | `Promise<V \| undefined>` | Wait for active loads, then read the cache. |
| `has(key)` | `boolean` | Check for a non-expired entry. |
| `all()` | `DynCacheEntry<K, V>[]` | Return live entries and remove expired ones. |
| `find(finder)` | `DynCacheEntry<K, V>[]` | Find live entries. |
| `remove(key)` | `DynCacheEntry<K, V> \| undefined` | Remove an entry and invalidate its pending cache write. |
| `removeByFinder(finder)` | `void` | Remove matching live entries. |
| `clear()` | `void` | Remove all entries and invalidate pending cache writes. |
| `getSize()` | `number` | Return the recorded total size in bytes. |
| `getLength()` | `number` | Return the recorded entry count. |
| `deactivate(noClear?)` | `void` | Stop scheduled cleanup and, by default, clear the cache. |

Size and count do not themselves trigger expiry cleanup.

## Custom engines

The package exports `MemoryEngine` and the `DynCacheEngine<K, V>` interface.
Custom engines store complete cache entries under the hashed string keys passed
by `DynCache`, and must implement:

```ts
import type { DynCacheEntry } from "@dre44/dyncache";

interface DynCacheEngine<K, V> {
    setValue(key: string, value: DynCacheEntry<K, V>): void;
    getValue(key: string): DynCacheEntry<K, V> | undefined;
    allKeys(): string[];
    removeValue(key: string): void;
}
```

All engine methods must be synchronous. Asynchronous loading belongs in a
`lock` factory, not in the engine.

## Cleanup

- `clear()` removes entries but keeps scheduled cleanup running.
- `deactivate()` stops scheduled cleanup, removes entries, and invalidates pending
  cache writes.
- `deactivate(true)` stops scheduled cleanup without removing entries or
  invalidating pending cache writes.

The built-in timer is unreferenced where supported, so it does not keep a Node.js
process alive. Custom scheduler startup errors, scheduled cleanup errors, and
errors while clearing during deactivation are logged to `console.error`.
