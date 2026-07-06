import { BaseDynCache } from "./base-dyn-cache.js";
import { MemoryEngine } from "./memory-engine.js";
import {
    createEntry,
    createFinderPredicate,
    hash,
    isExpired,
    refreshEntryExpiry,
    shouldTrim,
    sortEntriesForTrim,
} from "./system.js";
import type {
    DynCacheConfig,
    DynCacheEngine,
    DynCacheEntry,
    EntryFinder,
    GetOptions,
    SetOptions,
} from "./types.js";

/**
 * @template BK The base key type
 * @template BV The base value type
 */
export class AsyncDynCache<BK = any, BV = any> extends BaseDynCache<BK, BV> {
    #engine: DynCacheEngine;

    #config: DynCacheConfig<BK, BV>;

    #size = 0;
    #length = 0;
    #maxSize: number;
    #maxEntrySize: number;
    #maxEntries: number;

    #activeGetEntries = new Map<string, Promise<DynCacheEntry<BK, BV> | undefined>>();
    #setVersionByKey = new Map<string, number>();
    #pendingSetByKey = new Map<string, Promise<void>>();

    constructor(config: DynCacheConfig<BK, BV> = {}) {
        super(config);
        this.#config = config;
        this.#engine = config.engine || new MemoryEngine();
        this.#maxSize = config.maxSize || Infinity;
        this.#maxEntrySize = config.maxEntrySize || config.maxSize || Infinity;
        this.#maxEntries = config.maxEntries || Infinity;
    }

    override getSize(): number {
        return this.#size;
    }

    override getLength(): number {
        return this.#length;
    }

    /**
     * @returns All entries in the cache
     */
    override async all(): Promise<DynCacheEntry<BK, BV>[]> {
        const keys = await this.#engine.allKeys();
        const now = Date.now();
        const entries: DynCacheEntry<BK, BV>[] = [];

        for (const key of keys) {
            const entry = (await this.#engine.getValue(key)) as DynCacheEntry<any, any> | undefined;
            if (!entry) {
                continue;
            }
            if (isExpired(now, entry)) {
                await this.remove(entry.key);
                continue;
            }
            entries.push(entry as DynCacheEntry<BK, BV>);
        }

        return entries;
    }

    /**
     * Sets a value in the cache
     * @throws Error if the entry size exceeds the max cache size
     */
    async set<K extends BK, V extends BV>(
        key: K,
        value: V,
        options?: SetOptions,
    ): Promise<DynCacheEntry<K, V>> {
        const k = hash(key);
        const setVersion = (this.#setVersionByKey.get(k) || 0) + 1;
        this.#setVersionByKey.set(k, setVersion);
        this.#activeGetEntries.delete(k);

        const entry = createEntry(key, value, this.#maxEntrySize, {
            ...this.#config.entryOptions,
            ...options,
        });

        const previousSet = this.#pendingSetByKey.get(k)?.catch(() => undefined) ?? Promise.resolve();
        let currentSet: Promise<void>;

        currentSet = previousSet.then(async () => {
            if (!this.#isLatestSetVersion(k, setVersion)) {
                return;
            }

            const existingEntry = (await this.#engine.getValue(k)) as DynCacheEntry<K, V> | undefined;

            if (existingEntry) {
                await this.#engine.removeValue(k);
                this.#size -= existingEntry.size;
                this.#length--;
                await this.#config.onRemove?.(existingEntry);
            }

            if (!this.#isLatestSetVersion(k, setVersion)) {
                return;
            }

            await this.#trim(this.getSize() + entry.size, this.getLength() + 1);

            if (!this.#isLatestSetVersion(k, setVersion)) {
                return;
            }

            await this.#engine.setValue(k, entry);

            if (!this.#isLatestSetVersion(k, setVersion)) {
                await this.#engine.removeValue(k);
                return;
            }

            this.#size += entry.size;
            this.#length++;

            await this.#config.onSet?.(entry, existingEntry);
        });

        const trackedSet = currentSet.finally(() => {
            if (this.#pendingSetByKey.get(k) === trackedSet) {
                this.#pendingSetByKey.delete(k);
            }
        });

        this.#pendingSetByKey.set(k, trackedSet);

        await trackedSet;

        return entry;
    }

    async #trim(nextSize: number, nextLength: number): Promise<void> {
        if (!shouldTrim(nextSize, nextLength, this.#maxSize, this.#maxEntries)) {
            return;
        }

        const sortedEntries = sortEntriesForTrim(await this.all());
        let size = nextSize;
        let length = nextLength;

        while ((size > this.#maxSize || length > this.#maxEntries) && sortedEntries.length > 0) {
            const oldestEntry = sortedEntries.shift();
            if (!oldestEntry) {
                break;
            }
            await this.remove(oldestEntry.key);
            size -= oldestEntry.size;
            length--;
        }
    }

    /**
     * Gets an entry's value
     * @returns The value or undefined if not found or expired
     */
    async get<K extends BK = BK, V extends BV = BV>(key: K, options?: GetOptions): Promise<V | undefined> {
        return (await this.getEntry<K, V>(key, options))?.value;
    }

    /**
     * Gets an entry's value or sets it if not found
     * @returns The value
     */
    async getOrSet<K extends BK, V extends BV>(
        key: K,
        setFn: () => V | Promise<V>,
        getOptions?: GetOptions,
        setOptions?: SetOptions,
    ): Promise<V> {
        const entry = await this.getEntry<K, V>(key, getOptions);
        if (entry) {
            return entry.value;
        }

        const value = await setFn();
        await this.set(key, value, setOptions);
        return value;
    }

    /**
     * @returns The entry or undefined if not found or expired
     */
    async getEntry<K extends BK, V extends BV>(
        key: K,
        options?: GetOptions,
    ): Promise<DynCacheEntry<K, V> | undefined> {
        const k = hash(key);
        const entry = (await this.#getEntryRaw(k)) as DynCacheEntry<K, V> | undefined;

        if (!entry) {
            return undefined;
        }

        refreshEntryExpiry(entry, { ...this.#config.entryOptions, ...options });
        return entry;
    }

    /**
     * Clears the cache:
     * - Remove all entries
     * - Call onRemove for each entry
     * - Reset size and length
     */
    async clear(): Promise<void> {
        for (const keyHash of new Set([...this.#setVersionByKey.keys(), ...this.#pendingSetByKey.keys()])) {
            this.#invalidateKey(keyHash);
        }

        this.#activeGetEntries.clear();
        this.#pendingSetByKey.clear();
        const keys = await this.#engine.allKeys();

        for (const key of keys) {
            const entry = await this.#engine.getValue(key);
            await this.#engine.removeValue(key);
            if (entry) {
                await this.#config.onRemove?.(entry);
            }
        }

        this.#size = 0;
        this.#length = 0;
    }

    /**
     * Removes an entry from the cache
     */
    override async remove<K extends BK = BK, V extends BV = BV>(
        key: K,
    ): Promise<DynCacheEntry<K, V> | undefined> {
        const k = hash(key);
        this.#invalidateKey(k);
        this.#activeGetEntries.delete(k);
        const entry = (await this.#engine.getValue(k)) as DynCacheEntry<K, V> | undefined;

        if (!entry) {
            return undefined;
        }

        await this.#engine.removeValue(k);
        this.#size -= entry.size;
        this.#length--;
        await this.#config.onRemove?.(entry);

        return entry;
    }

    /**
     * @returns If the key is in the cache
     */
    async has<K extends BK = BK>(key: K): Promise<boolean> {
        return !!(await this.getEntry(key));
    }

    /**
     * Finds entries by a finder function or object
     */
    async find(finder: EntryFinder<BK, BV>): Promise<DynCacheEntry<BK, BV>[]> {
        const predicate = createFinderPredicate(finder);
        const entries = await this.all();
        return entries.filter((entry) => predicate(entry));
    }

    /**
     * Removes entries by a finder function or object
     */
    async removeByFinder(finder: EntryFinder<BK, BV>): Promise<void> {
        const entries = await this.find(finder);
        for (const entry of entries) {
            await this.remove(entry.key);
        }
    }

    async #getEntryRaw(keyHash: string): Promise<DynCacheEntry<BK, BV> | undefined> {
        const existing = this.#activeGetEntries.get(keyHash);
        if (existing) {
            return existing;
        }

        const readPromise = (async () => {
            const entry = (await this.#engine.getValue(keyHash)) as DynCacheEntry<BK, BV> | undefined;
            if (!entry) {
                return undefined;
            }

            const now = Date.now();
            if (isExpired(now, entry)) {
                await this.remove(entry.key);
                return undefined;
            }

            return entry;
        })();

        this.#activeGetEntries.set(keyHash, readPromise);

        try {
            return await readPromise;
        } finally {
            if (this.#activeGetEntries.get(keyHash) === readPromise) {
                this.#activeGetEntries.delete(keyHash);
            }
        }
    }

    #isLatestSetVersion(keyHash: string, version: number): boolean {
        return (this.#setVersionByKey.get(keyHash) || 0) === version;
    }

    #invalidateKey(keyHash: string): void {
        this.#setVersionByKey.set(keyHash, (this.#setVersionByKey.get(keyHash) || 0) + 1);
        this.#activeGetEntries.delete(keyHash);
    }
}
