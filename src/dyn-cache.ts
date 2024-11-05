import { MemoryEngine } from "./memory-engine";
import type {
    DynCacheKey,
    DynCacheValue,
    DynCacheEngine,
    DynCacheConfig,
    DynCacheEntry,
    SetOptions,
    EntryFinder,
} from "./types";
import hash from "stable-hash";

export class DynCache<K extends DynCacheKey = DynCacheKey, V extends DynCacheValue = DynCacheValue> {
    private _config: DynCacheConfig;
    private _engine: DynCacheEngine;
    private _clearInterval: any;

    constructor(config: DynCacheConfig = {}) {
        this._config = config;
        this._engine = config.engine || new MemoryEngine();
        this.startClearInterval();
    }

    private startClearInterval() {
        if (this._config.clearInterval === 0 || this._config.clearInterval === Infinity) return;

        this._clearInterval = setInterval(() => {
            const now = Date.now();
            this.all().forEach((entry) => this.checkExpired(now, entry));
        }, this._config.clearInterval || 300000);
    }

    private checkExpired(now: number, entry: DynCacheEntry<K, V>): boolean {
        if (entry.expiresAt !== Infinity && entry.expiresAt < now) {
            this.remove(entry.key);
            return true;
        }
        return false;
    }

    /**
     * @returns All entries in the cache
     */
    all(): DynCacheEntry<K, V>[] {
        const keys = this._engine.allKeys();
        const now = Date.now();
        return keys
            .map((key) => {
                const entry: DynCacheEntry<K, V> = this._engine.getValue(key);
                if (!entry || this.checkExpired(now, entry)) return false;
                return entry;
            })
            .filter((e) => !!e);
    }

    /**
     * Sets a value in the cache
     */
    set(key: K, value: V, options?: SetOptions): void {
        const k = hash(key);
        const cacheTime = options?.cacheTime || this._config.cacheTime || Infinity;
        const entry: DynCacheEntry<K, V> = {
            key,
            value,
            tags: options?.tags || [],
            expiresAt: cacheTime === 0 || cacheTime === Infinity ? Infinity : Date.now() + cacheTime,
        };
        if (this._config.onSet) this._config.onSet(entry);
        this._engine.setValue(k, entry);
    }

    /**
     * Gets an entries value
     * @returns The value or undefined if not found or expired
     */
    get(key: K): V | undefined {
        return this.getEntry(key)?.value;
    }

    /**
     * @returns The entry or undefined if not found or expired
     */
    getEntry(key: K): DynCacheEntry<K, V> | undefined {
        const k = hash(key);
        const entry: DynCacheEntry<K, V> | undefined = this._engine.getValue(k);
        if (!entry || this.checkExpired(Date.now(), entry)) return undefined;
        return entry;
    }

    /**
     * Clears the cache
     */
    clear(): void {
        const keys = this._engine.allKeys();
        keys.forEach((key) => this._engine.remove(key));
    }

    /**
     * Removes an entry from the cache
     */
    remove(key: K): void {
        const k = hash(key);
        if (this._config.onRemove) {
            const entry: DynCacheEntry<K, V> | undefined = this._engine.getValue(k);
            if (entry) this._config.onRemove(entry);
        }
        this._engine.remove(k);
    }

    /**
     * @returns If the key is in the cache
     */
    has(key: K): boolean {
        const k = hash(key);
        return !!this._engine.getValue(k);
    }

    /**
     * Finds entries by a finder function or object
     */
    find(finder: EntryFinder<K, V>): DynCacheEntry<K, V>[] {
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
    removeByFinder(finder: EntryFinder<K, V>): void {
        const entries = this.find(finder);
        entries.forEach((entry) => this.remove(entry.key));
    }

    /**
     * Deactivates the clearing interval. The cache can still be used with `clearInterval: 0` behavior.
     */
    deactivate(): void {
        if (this._clearInterval !== undefined) clearInterval(this._clearInterval);
    }
}
