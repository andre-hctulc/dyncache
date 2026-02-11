import { MemoryEngine } from "./memory-engine.js";
import type {
    DynCacheEngine,
    DynCacheConfig,
    DynCacheEntry,
    SetOptions,
    EntryFinder,
    GetOptions,
    EntryCacheOptions,
} from "./types.js";
import hash from "stable-hash";
import sizeOf from "object-sizeof";

/**
 * @template BK The base key type
 * @template BV The base value type
 */
export class DynCache<BK = any, BV = any> {
    #config: DynCacheConfig;
    #engine: DynCacheEngine;
    #clearInterval: any;
    #size: number = 0;
    #length = 0;
    #maxSize: number;
    #maxEntrySize: number;
    #maxEntries: number;
    #entryCacheOptions: Omit<EntryCacheOptions, "tags">;
    #clearAbortController = new AbortController();

    constructor(config: DynCacheConfig<BK, BV> = {}) {
        this.#config = config;
        this.#engine = config.engine || new MemoryEngine();

        this.#maxSize = config.maxSize || Infinity;
        this.#maxEntries = config.maxEntries || Infinity;
        this.#maxEntrySize = config.maxEntrySize || Infinity;
        if (this.#maxSize < 0) {
            throw new Error("Max memory size must be a positive number or Infinity");
        }
        if (this.#maxEntries < 0) {
            throw new Error("Max entries must be a positive number or Infinity");
        }
        if (this.#maxEntrySize < 0) {
            throw new Error("Max entry size must be a positive number or Infinity");
        }

        this.#entryCacheOptions = {
            ttl: config.ttl ?? Infinity,
            refresh: config.refresh ?? false,
        };

        this.#startClearInterval();
    }

    #startClearInterval() {
        if (this.#config.clearIntervalLength === 0 || this.#config.clearIntervalLength === Infinity) {
            return;
        }

        const clear = () => {
            const now = Date.now();
            this.all().forEach((entry) => this.#checkExpired(now, entry));
        };
        const intervalLength = this.#config.clearIntervalLength || 300000;

        if (this.#config.startClearInterval) {
            this.#config.startClearInterval(intervalLength, clear, this.#clearAbortController.signal);
        } else {
            this.#clearInterval = setInterval(clear, intervalLength);
        }

        // Set up abort listener for cleanup
        this.#clearAbortController.signal.addEventListener("abort", () => {
            if (this.#clearInterval) {
                clearInterval(this.#clearInterval);
                this.#clearInterval = null;
            }
        });
    }

    #checkExpired(now: number, entry: DynCacheEntry<any, any>): boolean {
        if (entry.expiresAt !== Infinity && entry.expiresAt < now) {
            this.remove(entry.key);
            return true;
        }
        return false;
    }

    /**
     * @returns All entries in the cache
     */
    all(): DynCacheEntry<BK, BV>[] {
        const keys = this.#engine.allKeys();
        const now = Date.now();
        return keys
            .map((key) => {
                const entry: DynCacheEntry<any, any> = this.#engine.getValue(key);
                if (!entry || this.#checkExpired(now, entry)) return false;
                return entry;
            })
            .filter(Boolean) as DynCacheEntry<BK, BV>[];
    }

    /**
     * Sets a value in the cache
     * @throws Error if the entry size exceeds the max cache size
     */
    set<K extends BK, V extends BV>(key: K, value: V, options?: SetOptions): DynCacheEntry<K, V> {
        const k = hash(key);
        const cacheTime = options?.ttl ?? this.#entryCacheOptions.ttl ?? Infinity;

        const entry: DynCacheEntry<K, V> = {
            key,
            value,
            tags: options?.tags || [],
            expiresAt: cacheTime === 0 || cacheTime === Infinity ? Infinity : Date.now() + cacheTime,
            ttl: cacheTime,
            refresh: options?.refresh ?? !!this.#entryCacheOptions.refresh,
            size: 0,
        };

        entry.size = sizeOf(entry);
        if (entry.size > this.#maxEntrySize) {
            throw new Error(
                `Entry size (${entry.size} bytes) exceeds max entry size (${this.#maxEntrySize} bytes)`,
            );
        }

        // properly remove old entry:
        // - call remove event
        // - update size and length
        if (this.#engine.getValue(k)) {
            this.remove(key);
        }

        const newSize = this.#size + entry.size;
        const newLength = this.#length + 1;

        this.#trim(newSize, newLength);

        this.#engine.setValue(k, entry);
        this.#size = newSize;
        this.#length = newLength;

        this.#config.onSet?.(entry);

        return entry;
    }

    #trim(newSize: number, newLength: number) {
        if (this.#maxSize === Infinity && this.#maxEntries === Infinity) {
            return;
        }

        const sizeTrimRequired = newSize > this.#maxSize;
        const lengthTrimRequired = newLength > this.#maxEntries;

        if (!sizeTrimRequired && !lengthTrimRequired) {
            return;
        }

        const sortedEntries = this.all().sort((a, b) => a.expiresAt - b.expiresAt);

        if (sizeTrimRequired) {
            while (newSize > this.#maxSize && sortedEntries.length > 0) {
                const oldestEntry = sortedEntries.shift();
                if (oldestEntry) {
                    this.remove(oldestEntry.key);
                    newSize -= oldestEntry.size;
                }
            }
        }
        if (lengthTrimRequired) {
            while (newLength > this.#maxEntries && sortedEntries.length > 0) {
                const oldestEntry = sortedEntries.shift();
                if (oldestEntry) {
                    this.remove(oldestEntry.key);
                    newLength--;
                }
            }
        }
    }

    /**
     * Gets an entries value
     * @returns The value or undefined if not found or expired
     */
    get<V extends BV = BV, K extends BK = BK>(key: K, options?: GetOptions): V | undefined {
        return this.getEntry<K, V>(key, options)?.value;
    }

    /**
     * Gets an entry's value or sets it if not found
     * @returns The value
     */
    getOrSet<K extends BK, V extends BV>(
        key: K,
        value: () => V,
        getOptions?: GetOptions,
        setOptions?: SetOptions,
    ): V {
        const entry = this.getEntry<K, V>(key, getOptions);

        if (entry) {
            return entry.value;
        }

        const val = value();
        this.set(key, val, setOptions);
        return val;
    }

    /**
     * @returns The entry or undefined if not found or expired
     */
    getEntry<K extends BK, V extends BV>(key: K, options?: GetOptions): DynCacheEntry<K, V> | undefined {
        const k = hash(key);
        const entry: DynCacheEntry<K, V> | undefined = this.#engine.getValue(k);
        const now = Date.now();

        // expired?
        if (!entry || this.#checkExpired(now, entry)) {
            return undefined;
        }

        // refresh?
        if (
            entry.expiresAt !== Infinity &&
            (options?.refresh ?? entry?.refresh ?? this.#entryCacheOptions.refresh)
        ) {
            entry.expiresAt = now + entry.ttl;
        }

        return entry;
    }

    /**
     * Clears the cache
     * @param silent If true, does not call the onRemove callback
     */
    clear(): void {
        this.#engine.allKeys().forEach((key) => this.#engine.remove(key));
        this.#size = 0;
        this.#length = 0;
    }

    /**
     * Removes an entry from the cache
     */
    remove<K extends BK = BK, V extends BV = BV>(key: K): DynCacheEntry<K, V> | undefined {
        const k = hash(key);
        const entry = this.#engine.getValue(k);

        if (!entry) return undefined;

        this.#engine.remove(k);
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
        let someTags: Set<string> | undefined;
        let everyTags: Set<string> | undefined;
        let keysToFind: Set<string> | undefined;
        const isFunc = typeof finder === "function";

        if (!isFunc) {
            if (finder.someTag) someTags = new Set(finder.someTag);
            if (finder.everyTag) everyTags = new Set(finder.everyTag);
            if (finder.keys) keysToFind = new Set(finder.keys.map((k) => hash(k)));
        }

        return this.all().filter((entry) => {
            if (!entry) return;

            if (isFunc) {
                if (finder(entry)) return true;
                return false;
            } else {
                if (!keysToFind && !someTags && !everyTags) return false;
                if (keysToFind && !keysToFind.has(hash(entry.key))) return false;
                if (someTags && !entry.tags.some((t) => someTags.has(t))) return false;
                if (everyTags && !entry.tags.every((t) => everyTags.has(t))) return false;
                return true;
            }
        });
    }

    /**
     * Removes entries by a finder function or object
     */
    removeByFinder(finder: EntryFinder<BK, BV>): void {
        this.find(finder).forEach((entry) => this.remove(entry.key));
    }

    /**
     * Deactivates the clearing interval. The cache can still be used, but with `clearInterval: 0` behavior.
     */
    deactivate(): void {
        this.#clearAbortController.abort();
    }

    /**
     * A helper function to create a key
     * @returns The key
     */
    createKey<K extends BK>(key: K): K {
        return key;
    }

    getSize(): number {
        return this.#size;
    }

    getLength(): number {
        return this.#length;
    }
}
