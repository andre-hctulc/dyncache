# dyncache

Dynamic Cache.

## Features

-   Complex keys
-   Find/Remove entries by tags, keys or custom finders
-   Support for custom engines

## Basic Usage

```ts
const cache = new DynCache();

// Set:
//project.config can be any serializable object
cache.set(project.config, project);

// Retrieve:
// If the item does not exist in the index or is expired undefined is returned.
const project = cache.get(config);

// Remove:
cache.remove(config);
```

## Cache Behavior

By default all items are cached infinitely.
Disable the cache by settings the cache time to 0 or Infinity.
A cache can set the cache time for its items. It can be overwritten for single items on set.

The items are checked for expiration in an interval of 60 seconds. The length can be customized.
