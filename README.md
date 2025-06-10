# dyncache

Dynamic Cache.

## Features

-   Simple or complex keys (strings, numbers, objects, arrays, ...)
-   Find/Remove entries by tags, keys or custom finders
-   Support for custom engines
-   _onSet_ and _onRemove_ listeners
-   Max memory size
-   TTL

## Basic Usage

```ts
const cache = new DynCache();

cache.set(project.config, project);

const project = cache.get(config);

cache.remove(config);

// Deactivate the cache. Required when clear interval is used (default).
cache.deactivate();
```

## Config

`engine`

The cache engine to use. Defaults to a **memory engine**.

`clearInterval`

Defaults to **5 minutes**.
The entries are checked for expiration in an interval.
Disable the clear interval by setting this to 0 or Infinity. Then the entries will be checked and removed on retrieval.

`maxSize`

Max size in bytes.

`onSet`,`onRemove`

Set/remove listener.

## Cache Options

`ttl`

Time to live in milliseconds.
By default entries are **cached infinitely**.
Disable the cache by settings the cache time to 0 or Infinity.

`refresh`

Refresh ttl on retrieval?

`tags`

Tags can be assigned to cache entries to improve entry filtering.
