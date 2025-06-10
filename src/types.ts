export interface DynCacheEngine {
    /**
     * Sets the value for the key.
     */
    setValue(key: string, value: any): void;
    /**
     * @returns The value or undefined if the key is not found.
     */
    getValue(key: string): any;
    /**
     * @returns All keys in the cache.
     */
    allKeys(): string[];
    /**
     * Removes the key from the cache.
     */
    remove(key: string): void;
}

export interface CacheOptions {
    /**
     * Milliseconds to keep item in cache. Set to 0 to disable.
     * @default 0
     */
    ttl?: number;
    /**
     * Refresh ttl on retrieval.
     */
    refresh?: boolean;
    /**
     * Tags to add to the entry.
     */
    tags?: string[];
}

export interface DynCacheConfig {
    /**
     * The cache engine to use.
     * @default MemoryEngine
     */
    engine?: DynCacheEngine;
    /**
     * Base cache options. Can be overridden per entry.
     */
    baseCacheOptions?: CacheOptions;
    /**
     * Clear interval in milliseconds. Defaults to 5 minutes.
     *
     * Set to Infinity or 0 to disable.
     * When disabled, the entries will be removed on retrieval if they are expired.
     * @default 300000
     */
    clearInterval?: number;
    /**
     * Callback when an entry is removed.
     */
    onRemove?: (entry: DynCacheEntry<any, any>) => void;
    /**
     * Callback when an entry is set.
     */
    onSet?: (entry: DynCacheEntry<any, any>) => void;
    /**
     * Max cache size in bytes.
     * @default Infinity
     */
    maxSize?: number;
}

export type EntryFinder<K, V> =
    | ((key: DynCacheEntry<K, V>) => boolean)
    | {
          /** List of keys to allow */
          keys?: string[];
          /**
           * Entries must have at least one of these tags.
           * */
          someTag?: string[];
          /**
           * Entries must have all of these tags.
           */
          everyTag?: string[];
      };

export interface DynCacheEntry<K, V> {
    /**
     * The key of the entry.
     */
    key: K;
    /**
     * The value of the entry.
     */
    value: V;
    /**
     * Tags associated with the entry.
     */
    tags: string[];
    /**
     * Timestamp when the entry expires.
     */
    expiresAt: number;
    /**
     * Size in bytes
     */
    size: number;
    /**
     * Global refresh flag.
     */
    refresh: boolean;
    ttl: number;
}

export interface SetOptions extends CacheOptions {}

export type GetOptions = {
    /**
     * If true, the entry cache time will be refreshed.
     *
     * This option takes precedence over {@link SetOptions.refresh}.
     */
    refresh?: boolean;
};
