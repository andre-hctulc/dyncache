import { InvalidDynCacheOptionsError, PromiseNotAllowedError } from "./errors.js";
import { MemoryEngine } from "./memory-engine.js";
import type { Lockable, LockFn } from "./lockable.js";
import {
    createEntry,
    createFinderPredicate,
    hash,
    isExpired,
    refreshEntryExpiry,
    runSafely,
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
export class DynCache<BK = any, BV = any> implements Lockable<BK, BV> {
    #engine: DynCacheEngine<BK, BV>;

    #config: DynCacheConfig<BK, BV>;

    #size = 0;
    #length = 0;
    #maxSize: number;
    #maxEntrySize: number;
    #maxEntries: number;
    #clearAbortController = new AbortController();
    #clearIntervalRef?: ReturnType<typeof setInterval>;
    #locks = new Map<string, Promise<Awaited<BV>>>();

    constructor(config: DynCacheConfig<BK, BV> = {}) {
        this.#config = config;
        this.#engine = config.engine || new MemoryEngine();

        this.#maxSize = config.maxSize || Infinity;
        this.#maxEntrySize = config.maxEntrySize || config.maxSize || Infinity;
        this.#maxEntries = config.maxEntries || Infinity;

        if (this.#maxSize < 0) {
            throw new InvalidDynCacheOptionsError("Max memory size must be a positive number or Infinity");
        }
        if (this.#maxEntries < 0) {
            throw new InvalidDynCacheOptionsError("Max entries must be a positive number or Infinity");
        }
        if (this.#maxEntrySize < 0) {
            throw new InvalidDynCacheOptionsError("Max entry size must be a positive number or Infinity");
        }
        if (this.#maxEntrySize > this.#maxSize) {
            throw new InvalidDynCacheOptionsError("Max entry size cannot be larger than max cache size");
        }

        this.#startClearInterval();
    }

    #startClearInterval(): void {
        const intervalLength = this.#config.clearIntervalLength ?? 300000;
        if (intervalLength === 0 || intervalLength === Infinity) {
            return;
        }

        const clear = () => {
            runSafely(
                () => {
                    this.all();
                },
                (err) => console.error("Error occurred while clearing expired entries from cache", err),
            );
        };

        const startClearInterval = this.#config.startClearInterval;
        if (startClearInterval) {
            runSafely(
                () => startClearInterval(intervalLength, clear, this.#clearAbortController.signal),
                (err) => console.error("Error occurred while starting cache clearing interval", err),
            );
        } else {
            this.#clearIntervalRef = setInterval(clear, intervalLength);
            const interval: unknown = this.#clearIntervalRef;
            if (typeof interval === "object" && interval !== null && "unref" in interval &&
                typeof interval.unref === "function") {
                interval.unref();
            }
        }
    }

    /**
     * Deactivates the clearing interval and clears entries unless noClear is true.
     */
    deactivate(noClear = false): void {
        this.#clearAbortController.abort();
        if (this.#clearIntervalRef !== undefined) {
            clearInterval(this.#clearIntervalRef);
            this.#clearIntervalRef = undefined;
        }
        if (!noClear) {
            runSafely(
                () => this.clear(),
                (err) => console.error("Error occurred while clearing cache during deactivation", err),
            );
        }
    }

    #synchronous<T>(value: T): T {
        if (value instanceof Promise) {
            throw new PromiseNotAllowedError();
        }
        return value;
    }

    #removeEntry(keyHash: string, entry: DynCacheEntry<BK, BV>): void {
        this.#synchronous(this.#engine.removeValue(keyHash));
        this.#size -= entry.size;
        this.#length--;
        this.#config.onRemove?.(entry);
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
    all(): DynCacheEntry<BK, BV>[] {
        const keys = this.#synchronous(this.#engine.allKeys());
        const now = Date.now();
        const entries: DynCacheEntry<BK, BV>[] = [];

        for (const key of keys) {
            const entry = this.#synchronous(this.#engine.getValue(key));
            if (!entry) {
                continue;
            }
            if (isExpired(now, entry)) {
                this.#removeEntry(key, entry);
            } else {
                entries.push(entry);
            }
        }
        return entries;
    }

    /**
     * Sets a value in the cache
     * @throws Error if the entry size exceeds the max cache size
     */
    set<K extends BK, V extends BV>(key: K, value: V, options?: SetOptions): DynCacheEntry<K, V> {
        const k = hash(key);
        const entry = createEntry(
            key,
            value,
            this.#maxEntrySize,
            this.#config.entryOptions || {},
            options || {},
        );

        this.#locks.delete(k);
        const existingEntry = this.#synchronous(this.#engine.getValue(k)) as DynCacheEntry<K, V> | undefined;
        if (existingEntry) {
            this.#removeEntry(k, existingEntry);
        }

        this.#trim(entry.size);

        this.#synchronous(this.#engine.setValue(k, entry));

        this.#size += entry.size;
        this.#length++;

        this.#config.onSet?.(entry, existingEntry);

        return entry;
    }

    #trim(entrySize: number): void {
        if (!shouldTrim(this.#size + entrySize, this.#length + 1, this.#maxSize, this.#maxEntries)) {
            return;
        }

        const entries = this.all();
        if (!shouldTrim(this.#size + entrySize, this.#length + 1, this.#maxSize, this.#maxEntries)) {
            return;
        }
        for (const entry of sortEntriesForTrim(entries)) {
            if (!shouldTrim(this.#size + entrySize, this.#length + 1, this.#maxSize, this.#maxEntries)) {
                break;
            }
            this.remove(entry.key);
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
     * Returns a cached value or shares one asynchronous retrieval per key.
     */
    lock(key: BK, fn: LockFn<BV>): Promise<Awaited<BV>> {
        const k = hash(key);
        const active = this.#locks.get(k);
        if (active) {
            return active;
        }

        try {
            const entry = this.getEntry(key);
            if (entry) {
                return Promise.resolve(entry.value);
            }
        } catch (error) {
            return Promise.reject(error);
        }

        // Defer invocation until the promise is registered, including for synchronous factories.
        const pending: Promise<Awaited<BV>> = Promise.resolve()
            .then(async (): Promise<Awaited<BV>> => await fn())
            .then((value): Awaited<BV> => {
                if (this.#locks.get(k) === pending) {
                    this.set(key, value);
                }
                return value;
            })
            .finally(() => {
                if (this.#locks.get(k) === pending) {
                    this.#locks.delete(k);
                }
            });
        this.#locks.set(k, pending);
        return pending;
    }

    /**
     * Waits for active retrievals and reads the current cached value.
     */
    async lockGet(key: BK): Promise<BV | undefined> {
        const k = hash(key);
        let active = this.#locks.get(k);
        while (active) {
            await active;
            active = this.#locks.get(k);
        }
        return this.get(key);
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
        const entry = this.#synchronous(this.#engine.getValue(k)) as DynCacheEntry<K, V> | undefined;

        if (!entry) {
            return undefined;
        }

        const now = Date.now();
        if (isExpired(now, entry)) {
            this.#removeEntry(k, entry);
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
        this.#locks.clear();
        const keys = this.#synchronous(this.#engine.allKeys());
        for (const key of keys) {
            const entry = this.#synchronous(this.#engine.getValue(key));
            if (entry) {
                this.#removeEntry(key, entry);
            } else {
                this.#synchronous(this.#engine.removeValue(key));
            }
        }

        this.#size = 0;
        this.#length = 0;
    }

    /**
     * Removes an entry from the cache
     */
    remove<K extends BK = BK, V extends BV = BV>(key: K): DynCacheEntry<K, V> | undefined {
        const k = hash(key);
        this.#locks.delete(k);
        const entry = this.#synchronous(this.#engine.getValue(k)) as DynCacheEntry<K, V> | undefined;

        if (!entry) {
            return undefined;
        }

        this.#removeEntry(k, entry);

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
