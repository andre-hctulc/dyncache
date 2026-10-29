# DynCache

`DynCache` is the single, standalone synchronous cache implementation.
`AsyncDynCache` and `BaseDynCache` have been removed. Replace imports and
construction of `AsyncDynCache` with `DynCache` only when using a synchronous
engine; asynchronous engines are no longer supported.

Custom `DynCacheEngine` implementations must return values synchronously from
`getValue`, `setValue`, `allKeys`, and `removeValue`. Normal cache methods return values
directly; `lock` and `lockGet` return promises. Custom interval startup hooks may still return a promise;
startup and cleanup errors are logged.

Configuration, TTL refresh, tag/key finders, callbacks, and cache limits remain
available. Eviction removes entries with the earliest expiration first, retaining
engine order for ties. Expired entries are removed before deciding whether live
entries need to be evicted.

`clearIntervalLength` defaults to 300000 milliseconds. Set it to `0` or `Infinity`
to disable scheduled cleanup; reads still remove expired entries.
`deactivate()` stops scheduled cleanup and clears the cache.
`deactivate(true)` stops cleanup without clearing entries.

## Deduplicating asynchronous retrievals

```ts
const cache = new DynCache<string, Project>();

const project = await cache.lock("project:1", () => loadProject("1"));
const sameProject = await cache.lockGet("project:1");
```

`lock(key, fn)` returns a cached value on a hit. On a miss, it registers a
per-key promise before invoking `fn`. Concurrent calls for equivalent keys
(using the cache's normal key hashing) share that promise; only the first
factory runs. Different keys can load independently. Synchronous factories
are also supported. Results use the normal `set` path, including configured
TTL, limits, and callbacks.

Pass `{ noRead: true }` as the third argument to skip the cached value and reload.
An active retrieval still takes precedence and is shared, regardless of `noRead`.
The existing entry remains available to synchronous readers while the reload runs;
if the factory fails, it is not replaced.

`lockGet(key)` waits for active retrievals and then returns the current cache
value, or `undefined` if absent. It never starts a retrieval. Plain `get` and
`has` remain synchronous and do not wait for locks.

Retrieval and cache-write errors reject the promise and release the lock so
subsequent calls can retry. Always await or handle the returned promises.
Factories must not await their own key's lock (directly or through a dependency
cycle).

Explicit `set`, `remove` (even for an absent key), and `clear` invalidate pending
cache writes for affected keys. `deactivate()` also invalidates them by clearing;
`deactivate(true)` leaves them active. Invalidation does not cancel external work:
existing `lock` callers still receive its result or error, but stale results
are not cached. Waiting `lockGet` callers read the current cache state after
the retrieval completes. A new lock can start after invalidation, and completion
of an older retrieval does not release the newer lock.

These locks coordinate calls within one cache instance, not across processes.
