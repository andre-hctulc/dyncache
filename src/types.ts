export type MaybePromise<T> = Awaited<T> | Promise<T>;

export interface DynCacheEngine<K = any, V = any> {
    /**
     * Sets the value for the key.
     */
    setValue(key: string, value: DynCacheEntry<K, V>): void;
    /**
     * @returns The value or undefined if the key is not found.
     */
    getValue(key: string): DynCacheEntry<K, V> | undefined;
    /**
     * @returns All keys in the cache.
     */
    allKeys(): string[];
    /**
     * Removes the key from the cache.
     */
    removeValue(key: string): void;
}

export interface EntryCacheOptions {
    /**
     * Milliseconds to keep item in cache. Set to 0 or Infinity to disable.
     * @default Infinity
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

export interface DynCacheConfig<K = any, V = any> {
    entryOptions?: EntryCacheOptions;
    /**
     * The synchronous cache engine to use. Promise-returning engines are not supported.
     * @default MemoryEngine
     */
    engine?: DynCacheEngine<K, V>;
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
    startClearInterval?: (
        clearIntervalLength: number,
        clear: () => MaybePromise<void>,
        abortSignal: AbortSignal,
    ) => MaybePromise<void>;
    /**
     * Callback when an entry is removed.
     */
    onRemove?: (entry: DynCacheEntry<K, V>) => void;
    /**
     * Callback when an entry is set.
     */
    onSet?: (entry: DynCacheEntry<K, V>, previousEntry?: DynCacheEntry<K, V>) => void;
    /**
     * Max cache size in bytes.
     * @default Infinity
     */
    maxSize?: number;
    /**
     * Max number of entries in the cache. Set to 0 or Infinity to disable.
     * @default Infinity
     */
    maxEntries?: number;
    /**
     * Max size of a single entry in bytes. Set to 0 or Infinity to disable.
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
     * Refresh flag indicating if the entry's TTL should be refreshed.
     */
    refresh: boolean;
    ttl: number;
    id: string;
}

export interface SetOptions extends EntryCacheOptions {}

export interface GetOptions {
    /**
     * If true, the entry cache time will be refreshed.
     *
     * This option takes precedence over {@link SetOptions.refresh}.
     */
    refresh?: boolean;
}

export interface LockOptions extends GetOptions, SetOptions {
    /**
     * If true, skips reading the current cached value before invoking the lock function.
     */
    noRead?: boolean;
}

export type LockFn<V> = () => MaybePromise<V>;
