# dyncache

Dynamic Cache.

## Features

-   Complex keys
-   Find/Remove entries by tags, keys or custom finders
-   Support for custom engines
-   _onSet_ and _onRemove_ listeners

## Basic Usage

```ts
// Init:
const cache = new DynCache();

// Set:
// The key can be any serializable object
cache.set(project.config, project);

// Retrieve:
// If the item does not exist in the cache or is expired undefined is returned
const project = cache.get(config);

// Remove:
cache.remove(config);

// Deactivate:
// Deactivates the clear interval.
// The cache can still be used, but with "clearInterval: 0" behavior
cache.deactivate();
```

## Config

`engine`

The cache engine to use. Defaults to a **memory engine**.

`cacheTime`

By default entries are **cached infinitely**.
Disable the cache by settings the cache time to 0 or Infinity.
A cache can set the cache time for its items. It can be overwritten for single items on set.

`clearInterval`

Defaults to **5 minutes**.
The entries are checked for expiration in an interval.
Disable the clear interval by setting this to 0 or Infinity. Then the entries will be checked and removed on retrieval.
