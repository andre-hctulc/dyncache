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
import { type PromiseOptions } from "./types.js";
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
        if (this.#maxEntrySize > this.#maxSize) {
            throw new Error("Max entry size cannot be larger than max cache size");
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
        const existingEntry = this.#engine.getValue(k);
        if (existingEntry) {
            this.#engine.remove(k);
            this.#size -= existingEntry.size;
            this.#length--;
            this.#config.onRemove?.(existingEntry);
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
    get<K extends BK = BK, V extends BV = BV>(key: K, options?: GetOptions): V | undefined {
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
     * Clears the cache:
     * - Remove all entries
     * - Call onRemove for each entry
     * - Reset size and length
     * - Release all locks
     */
    clear(): void {
        this.#engine.allKeys().forEach((key) => {
            const entry = this.#engine.getValue(key);
            this.#engine.remove(key);
            if (entry) {
                this.#config.onRemove?.(entry);
            }
        });
        this.#size = 0;
        this.#length = 0;
        this.releaseAll();
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
    deactivate(noClear = false): void {
        this.#clearAbortController.abort();
        if (!noClear) {
            this.clear();
        }
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

    #locks: Map<string, { prom: Promise<BV>; abortController: AbortController } | true> = new Map();

    unlock<K extends BK>(key: K): void {
        const k = hash(key);
        const currentLock = this.#locks.get(k);
        if (typeof currentLock === "object") {
            currentLock.abortController.abort();
        }
        this.#locks.delete(k);
    }

    isLocked<K extends BK>(key: K): boolean {
        const k = hash(key);
        return this.#locks.has(k);
    }

    /**
     * @returns Did lock apply?
     */
    release<K extends BK>(key: K, { overrule }: PromiseOptions = {}): boolean {
        const k = hash(key);
        const currentLock = this.#locks.get(k);
        if (overrule) {
            if (typeof currentLock === "object") {
                currentLock.abortController.abort();
            }
            this.#locks.set(k, true);
            return true;
        } else {
            if (currentLock) {
                return false;
            } else {
                this.#locks.set(k, true);
                return true;
            }
        }
    }

    /**
     * Releases all promises.
     */
    releaseAll(): void {
        for (const [k, lock] of this.#locks.entries()) {
            if (typeof lock === "object") {
                lock.abortController.abort();
            }
        }
        this.#locks.clear();
    }

    /**
     * Locks a key until the provided promise resolves, then sets the resolved value.
     * If overrule is set, it will acquire the lock even if it's currently held by another process, and overwrite the value when the promise resolves.
     * {@link set} still sets values despite locks. To opt into full lock support only utilize the lock api.
     * @returns A promise that resolves with the value, or the existing in-flight promise if the lock is currently held by a managed lock and overrule is not set
     */
    promise<K extends BK, V extends BV>(
        key: K,
        promiseFn: (abortSignal: AbortSignal) => Promise<V>,
        options: PromiseOptions = {},
    ): Promise<V> {
        const k = hash(key);
        const currentLock = this.#locks.get(k);

        if (!options.overrule && currentLock) {
            if (currentLock === true) {
                throw new Error("The lock for this key cannot be used as promise");
            }
            if (currentLock) {
                return currentLock.prom as Promise<V>;
            }
        }

        if (typeof currentLock === "object") {
            currentLock.abortController.abort();
        }

        const abortController = new AbortController();

        // Acquire lock before calling promiseFn to prevent re-entrant duplicate locks
        this.#locks.set(k, true);

        let prom: Promise<V>;
        try {
            prom = promiseFn(abortController.signal);
        } catch (err) {
            this.#locks.delete(k);
            return Promise.reject(err);
        }

        this.#locks.set(k, { prom, abortController });

        prom.then(
            (v) => {
                const currentLock = this.#locks.get(k);
                if (typeof currentLock === "object" && currentLock.prom === prom) {
                    this.set(key, v, options);
                }
            },
            () => {
                // prevent unhandled rejection on internal chain; caller handles rejection via `prom`
            },
        ).finally(() => {
            const currentLock = this.#locks.get(k);
            if (typeof currentLock === "object" && currentLock.prom === prom) {
                this.#locks.delete(k);
            }
        });

        return prom;
    }

    async getOrPromise<K extends BK, V extends BV>(
        key: K,
        promiseFn: (abortSignal: AbortSignal) => Promise<V>,
        getOptions?: GetOptions,
        promiseOptions?: PromiseOptions,
    ): Promise<V> {
        const existingEntry = this.getEntry<K, V>(key, getOptions);
        if (existingEntry) {
            return existingEntry.value;
        }
        return this.promise<K, V>(key, promiseFn, promiseOptions);
    }

    /**
     * Overruled promises are not taken into account while awaiting the promise once retrieved!
     * @returns Gets the entry or the latest promise if available.
     */
    async getPromised<K extends BK, V extends BV>(key: K, options?: GetOptions): Promise<V | undefined> {
        const k = hash(key);
        const currentLock = this.#locks.get(k);
        if (currentLock === true) {
            return this.get<K, V>(key, options);
        }
        if (currentLock) {
            return currentLock.prom as Promise<V>;
        }
        return this.get<K, V>(key, options);
    }
}
