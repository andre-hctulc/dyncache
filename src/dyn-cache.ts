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

    constructor(config: DynCacheConfig = {}) {
        this._config = config;
        this._engine = config.engine || new MemoryEngine();
        this.startClearInterval();
    }

    private startClearInterval() {
        if (this._config.clearInterval === 0 || this._config.clearInterval === Infinity) return;

        setInterval(() => {
            const now = Date.now();
            this.all().forEach((entry) => this.checkExpired(now, entry));
        }, this._config.clearInterval || 60000);
    }

    private checkExpired(now: number, entry: DynCacheEntry<K, V>): boolean {
        if (entry.expiresAt && entry.expiresAt < now) {
            this.remove(entry.key);
            return true;
        }
        return false;
    }

    all(): DynCacheEntry<K, V>[] {
        const keys = this._engine.allKeys();
        const now = Date.now();
        return keys
            .map((key) => {
                const entry: DynCacheEntry<K, V> = this._engine.getValue(key);
                if (this.checkExpired(now, entry)) return;
                return entry;
            })
            .filter((e) => !!e);
    }

    set(key: K, value: V, options?: SetOptions): void {
        const k = hash(key);
        const cacheTime = options?.cacheTime || this._config.cacheTime || Infinity;
        const entry: DynCacheEntry<K, V> = {
            key,
            value,
            tags: options?.tags || [],
            expiresAt: cacheTime === 0 || cacheTime === Infinity ? Infinity : Date.now() + cacheTime,
        };
        this._engine.setValue(k, entry);
    }

    get(key: K): V | undefined {
        return this.getEntry(key)?.value;
    }

    getEntry(key: K): DynCacheEntry<K, V> | undefined {
        const k = hash(key);
        const entry: DynCacheEntry<K, V> | undefined = this._engine.getValue(k);
        if (!entry || this.checkExpired(Date.now(), entry)) return undefined;
        return entry;
    }

    clear(): void {
        const keys = this._engine.allKeys();
        keys.forEach((key) => this._engine.remove(key));
    }

    remove(key: K): void {
        const k = hash(key);
    }

    has(key: K): boolean {
        const k = hash(key);
        return !!this._engine.getValue(k);
    }

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

    removeByFinder(finder: EntryFinder<K, V>): void {
        const entries = this.find(finder);
        entries.forEach((entry) => this.remove(entry.key));
    }
}
