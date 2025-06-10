import { MemoryEngine } from "./memory-engine.js";
import type {
    DynCacheEngine,
    DynCacheConfig,
    DynCacheEntry,
    SetOptions,
    EntryFinder,
    GetOptions,
    CacheOptions,
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
    #maxSize: number;
    #baseCacheOptions: CacheOptions;

    constructor(config: DynCacheConfig = {}) {
        this.#config = config;
        this.#engine = config.engine || new MemoryEngine();
        this.#startClearInterval();
        this.#maxSize = config.maxSize || Infinity;
        if (this.#maxSize < 0) {
            throw new Error("Max memory size must be a positive number or Infinity");
        }
        this.#baseCacheOptions = config.baseCacheOptions || {};
    }

    #startClearInterval() {
        if (this.#config.clearInterval === 0 || this.#config.clearInterval === Infinity) return;

        this.#clearInterval = setInterval(() => {
            const now = Date.now();
            this.all().forEach((entry) => this.#checkExpired(now, entry));
        }, this.#config.clearInterval || 300000);
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
            .filter((e) => !!e);
    }

    /**
     * Sets a value in the cache
     * @throws Error if the entry size exceeds the max cache size
     */
    set<K extends BK, V extends BV>(key: K, value: V, options?: SetOptions): DynCacheEntry<K, V> {
        const k = hash(key);
        const cacheTime = options?.ttl ?? this.#baseCacheOptions.ttl ?? Infinity;

        const entry: DynCacheEntry<K, V> = {
            key,
            value,
            tags: options?.tags || this.#baseCacheOptions.tags || [],
            expiresAt: cacheTime === 0 || cacheTime === Infinity ? Infinity : Date.now() + cacheTime,
            ttl: cacheTime,
            refresh: options?.refresh ?? !!this.#baseCacheOptions.refresh,
            size: 0,
        };

        const _size = sizeOf(entry);
        entry.size = _size + sizeOf(_size);

        if (entry.size > this.#maxSize) {
            throw new Error(`Entry size (${_size} bytes) exceeds max cache size (${this.#maxSize} bytes)`);
        }

        if (this.#size + entry.size > this.#maxSize) {
            this.#trim();
        }

        this.#engine.setValue(k, entry);
        this.#size += entry.size;

        this.#config.onSet?.(entry);

        return entry;
    }

    #trim() {
        if (this.#maxSize === Infinity) {
            return;
        }

        const allEntries = this.all();

        allEntries.sort((a, b) => a.expiresAt - b.expiresAt);

        while (this.#size > this.#maxSize && allEntries.length > 0) {
            const oldestEntry = allEntries.shift();
            if (oldestEntry) {
                this.remove(oldestEntry.key);
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
        setOptions?: SetOptions
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
            (options?.refresh ?? entry?.refresh ?? this.#baseCacheOptions.refresh)
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

        this.#config.onRemove?.(entry);

        return entry;
    }

    /**
     * @returns If the key is in the cache
     */
    has<K = any>(key: K): boolean {
        return !!this.#engine.getValue(hash(key));
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
        const entries = this.find(finder);
        entries.forEach((entry) => this.remove(entry.key));
    }

    /**
     * Deactivates the clearing interval. The cache can still be used, but with `clearInterval: 0` behavior.
     */
    deactivate(): void {
        if (this.#clearInterval !== undefined) clearInterval(this.#clearInterval);
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
}
