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

export interface EntryCacheOptions {
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

export interface DynCacheConfig<K = any, V = any> extends Omit<EntryCacheOptions, "tags"> {
    /**
     * The cache engine to use.
     * @default MemoryEngine
     */
    engine?: DynCacheEngine;
    /**
     * Clear interval in milliseconds. Defaults to 5 minutes.
     *
     * Set to Infinity or 0 to disable.
     * When disabled, the entries will be removed on retrieval if they are expired.
     * @default 300000
     */
    clearIntervalLength?: number;
    /**
     * Custom clear interval function. Defaults to using setInterval.
     */
    startClearInterval?: (clearIntervalLength: number, clear: () => void, abortSignal: AbortSignal) => void;
    /**
     * Callback when an entry is removed.
     */
    onRemove?: (entry: DynCacheEntry<K, V>) => void;
    /**
     * Callback when an entry is set.
     */
    onSet?: (entry: DynCacheEntry<K, V>) => void;
    /**
     * Max cache size in bytes.
     * @default Infinity
     */
    maxSize?: number;
    /**
     * Max number of entries in the cache. Set to Infinity to disable.
     * @default Infinity
     */
    maxEntries?: number;
    /**
     * Max size of a single entry in bytes. Set to Infinity to disable.
     * @default Infinity
     */
    maxEntrySize?: number;
}

export type EntryFinder<K, V> =
    | ((entry: DynCacheEntry<K, V>) => boolean)
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
     * Original entry key.
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

export interface SetOptions extends EntryCacheOptions {}

export type GetOptions = {
    /**
     * If true, the entry cache time will be refreshed.
     *
     * This option takes precedence over {@link SetOptions.refresh}.
     */
    refresh?: boolean;
};
