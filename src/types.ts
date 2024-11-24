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

export interface DynCacheConfig {
    /**
     * The cache engine to use.
     * @default MemoryEngine
     */
    engine?: DynCacheEngine;
    /**
     * Milliseconds to keep the cache. Set to 0 to disable.
     * @default Infinity
     */
    cacheTime?: number;
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
}

export type DynCacheKey = any;
export type DynCacheValue = any;

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

export type DynCacheEntry<K, V> = {
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
     * Milliseconds to keep the entry in the cache.
     */
    cacheTime: number;
    /**
     * Global refresh flag.
     */
    refresh: boolean;
};

export type SetOptions = {
    /**
     * Tags to add to the entry.
     */
    tags?: string[];
    /**
     * Milliseconds to keep the entry in the cache. Set to 0 to disable.
     *
     * This option takes precedence over `DynCacheConfig.cacheTime`.
     */
    cacheTime?: number;
    /**
     * If true, the entry cache time will be refreshed on the next get.
     */
    refresh?: boolean;
};

export type GetOptions = {
    /**
     * If true, the entry cache time will be refreshed.
     *
     * This option takes precedence over `SetOptions.refresh`.
     */
    refresh?: boolean;
};
