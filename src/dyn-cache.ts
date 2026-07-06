import { BaseDynCache } from "./base-dyn-cache.js";
import { PromiseNotAllowedError } from "./errors.js";
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
    DynCacheEntry,
    EntryFinder,
    GetOptions,
    SetOptions,
    DynCacheEngine,
    DynCacheConfig,
} from "./types.js";

/**
 * @template BK The base key type
 * @template BV The base value type
 */
export class DynCache<BK = any, BV = any> extends BaseDynCache<BK, BV> {
    #engine: DynCacheEngine;

    #config: DynCacheConfig<BK, BV>;

    #size = 0;
    #length = 0;
    #maxSize: number;
    #maxEntrySize: number;
    #maxEntries: number;

    constructor(config: DynCacheConfig<BK, BV> = {}) {
        super(config);

        this.#config = config;
        this.#engine = config.engine || new MemoryEngine();

        this.#maxSize = config.maxSize || Infinity;
        this.#maxEntrySize = config.maxEntrySize || config.maxSize || Infinity;
        this.#maxEntries = config.maxEntries || Infinity;
    }

    getSize(): number {
        return this.#size;
    }

    getLength(): number {
        return this.#length;
    }

    /**
     * @returns All entries in the cache
     */
    override all(): DynCacheEntry<BK, BV>[] {
        const keys = this.#engine.allKeys();
        if (keys instanceof Promise) {
            throw new PromiseNotAllowedError();
        }

        const now = Date.now();

        return keys
            .map((key) => {
                const entry: DynCacheEntry<any, any> = this.#engine.getValue(key);
                if (!entry) {
                    return undefined;
                }
                if (isExpired(now, entry)) {
                    this.remove(entry.key);
                    return undefined;
                }
                return entry as DynCacheEntry<BK, BV>;
            })
            .filter(Boolean) as DynCacheEntry<BK, BV>[];
    }

    /**
     * Sets a value in the cache
     * @throws Error if the entry size exceeds the max cache size
     */
    set<K extends BK, V extends BV>(key: K, value: V, options?: SetOptions): DynCacheEntry<K, V> {
        const k = hash(key);
        const entry = createEntry(key, value, this.#maxEntrySize, {
            ...this.#config.entryOptions,
            ...options,
        });

        const existingEntry = this.#engine.getValue(k) as DynCacheEntry<K, V> | undefined;
        if (existingEntry) {
            const rem = this.#engine.removeValue(k);
            if (rem instanceof Promise) {
                throw new PromiseNotAllowedError();
            }

            this.#size -= existingEntry.size;
            this.#length--;
            this.#config.onRemove?.(existingEntry);
        }

        this.#trim(this.getSize() + entry.size, this.getLength() + 1);

        const set = this.#engine.setValue(k, entry);
        if (set && set instanceof Promise) {
            throw new PromiseNotAllowedError();
        }

        this.#size += entry.size;
        this.#length++;

        this.#config.onSet?.(entry, existingEntry);

        return entry;
    }

    #trim(nextSize: number, nextLength: number): void {
        if (!shouldTrim(nextSize, nextLength, this.#maxSize, this.#maxEntries)) {
            return;
        }

        const sortedEntries = sortEntriesForTrim(this.all());
        let size = nextSize;
        let length = nextLength;

        while ((size > this.#maxSize || length > this.#maxEntries) && sortedEntries.length > 0) {
            const oldestEntry = sortedEntries.shift();
            if (!oldestEntry) {
                break;
            }
            this.remove(oldestEntry.key);
            size -= oldestEntry.size;
            length--;
        }
    }

    /**
     * Gets an entry's value
     * @returns The value or undefined if not found or expired
     */
    get<K extends BK = BK, V extends BV = BV>(key: K, options?: GetOptions): V | undefined {
        return this.getEntry<K, V>(key, options)?.value;
    }

    /**
     * Gets an entry's value or sets it if not found
     * @returns The value
     */
    getOrSet<K extends BK, V extends BV>(
        key: K,
        setFn: () => V,
        getOptions?: GetOptions,
        setOptions?: SetOptions,
    ): V {
        const entry = this.getEntry<K, V>(key, getOptions);
        if (entry) {
            return entry.value;
        }

        const value = setFn();
        this.set(key, value, setOptions);
        return value;
    }

    /**
     * @returns The entry or undefined if not found or expired
     */
    getEntry<K extends BK, V extends BV>(key: K, options?: GetOptions): DynCacheEntry<K, V> | undefined {
        const k = hash(key);
        const entry = this.#engine.getValue(k);
        if (entry instanceof Promise) {
            throw new PromiseNotAllowedError();
        }

        if (!entry) {
            return undefined;
        }

        const now = Date.now();
        if (isExpired(now, entry)) {
            this.remove(entry.key);
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
    clear(): void {
        const keys = this.#engine.allKeys();
        if (keys instanceof Promise) {
            throw new PromiseNotAllowedError();
        }

        keys.forEach((key) => {
            const entry = this.#engine.getValue(key);
            this.#engine.removeValue(key);
            if (entry) {
                this.#config.onRemove?.(entry);
            }
        });

        this.#size = 0;
        this.#length = 0;
    }

    /**
     * Removes an entry from the cache
     */
    override remove<K extends BK = BK, V extends BV = BV>(key: K): DynCacheEntry<K, V> | undefined {
        const k = hash(key);
        const entry = this.#engine.getValue(k) as DynCacheEntry<K, V> | undefined;

        if (!entry) {
            return undefined;
        }

        this.#engine.removeValue(k);
        this.#size -= entry.size;
        this.#length--;
        this.#config.onRemove?.(entry);

        return entry;
    }

    /**
     * @returns If the key is in the cache
     */
    has<K extends BK = BK>(key: K): boolean {
        return !!this.getEntry(key);
    }

    /**
     * Finds entries by a finder function or object
     */
    find(finder: EntryFinder<BK, BV>): DynCacheEntry<BK, BV>[] {
        const predicate = createFinderPredicate(finder);
        return this.all().filter((entry) => predicate(entry));
    }

    /**
     * Removes entries by a finder function or object
     */
    removeByFinder(finder: EntryFinder<BK, BV>): void {
        this.find(finder).forEach((entry) => this.remove(entry.key));
    }
}
