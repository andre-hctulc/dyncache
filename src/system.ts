import { DynCacheEntry, EntryFinder, GetOptions, SetOptions } from "./types.js";
import * as stableHash from "stable-hash";
import sizeOf from "object-sizeof";
import { MaxEntrySizeExceededError } from "./errors.js";

export const hash: (input: any) => string = (stableHash as any).default || (stableHash as any);

export function runSafely(fn: () => any, onError?: (error: unknown) => void): void {
    try {
        const res = fn();
        if (res instanceof Promise) {
            res.catch((error) => {
                if (onError) {
                    onError(error);
                }
            });
        }
    } catch (error) {
        if (onError) {
            onError(error);
        }
    }
}

type FinderPredicate<BK, BV> = (entry: DynCacheEntry<BK, BV>) => boolean;

export function createFinderPredicate<K, V>(finder: EntryFinder<K, V>): FinderPredicate<K, V> {
    let someTags: Set<string> | undefined;
    let everyTags: Set<string> | undefined;
    let keysToFind: Set<string> | undefined;
    const isFunc = typeof finder === "function";

    if (!isFunc) {
        if (finder.someTag) {
            someTags = new Set(finder.someTag);
        }
        if (finder.everyTag) {
            everyTags = new Set(finder.everyTag);
        }
        if (finder.keys) {
            keysToFind = new Set(finder.keys.map((k) => hash(k)));
        }
    }

    return (entry) => {
        if (!entry) {
            return false;
        }

        if (isFunc) {
            return finder(entry);
        }

        if (!keysToFind && !someTags && !everyTags) {
            return false;
        }
        if (keysToFind && !keysToFind.has(hash(entry.key))) {
            return false;
        }
        if (someTags && !entry.tags.some((t) => someTags.has(t))) {
            return false;
        }
        if (everyTags && !entry.tags.every((t) => everyTags.has(t))) {
            return false;
        }
        return true;
    };
}

export function shouldTrim(newSize: number, newLength: number, maxSize: number, maxLength: number): boolean {
    if (maxSize === Infinity && maxLength === Infinity) {
        return false;
    }

    return newSize > maxSize || newLength > maxLength;
}

export function isExpired(now: number, entry: DynCacheEntry<any, any>): boolean {
    return entry.expiresAt !== Infinity && entry.expiresAt < now;
}

export function createEntry<K, V>(
    key: K,
    value: V,
    maxEntrySize: number,
    options?: SetOptions,
): DynCacheEntry<K, V> {
    const ttl = options?.ttl ?? Infinity;

    const entry: DynCacheEntry<K, V> = {
        key,
        value,
        tags: options?.tags || [],
        expiresAt: ttl === 0 || ttl === Infinity ? Infinity : Date.now() + ttl,
        ttl,
        refresh: options?.refresh ?? false,
        size: 0,
        // TODO improve?
        id: crypto.randomUUID(),
    };

    entry.size = sizeOf(entry);

    if (entry.size > maxEntrySize) {
        throw new MaxEntrySizeExceededError(entry.size, maxEntrySize);
    }

    return entry;
}

export function sortEntriesForTrim<K, V>(entries: DynCacheEntry<K, V>[]): DynCacheEntry<K, V>[] {
    return [...entries].sort((a, b) => a.expiresAt - b.expiresAt);
}

export function refreshEntryExpiry<K, V>(entry: DynCacheEntry<K, V>, options?: GetOptions): void {
    const refresh = options?.refresh ?? entry.refresh;
    if (entry.expiresAt !== Infinity && refresh) {
        entry.expiresAt = Date.now() + entry.ttl;
    }
}
