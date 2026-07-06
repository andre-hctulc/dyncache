export class DynCacheError extends Error {
    readonly dynCache = true;

    constructor(
        message: string,
        readonly code = "DYN_CACHE_ERROR",
        readonly details: Record<string, unknown> = {},
    ) {
        super(message);
    }
}

export class PromiseNotAllowedError extends DynCacheError {
    constructor() {
        super("Promise not allowed: Received a Promise in a synchronous cache", "PROMISE_NOT_ALLOWED");
    }
}

export class MaxEntrySizeExceededError extends DynCacheError {
    constructor(entrySize: number, maxEntrySize: number) {
        super(
            `Max entry size exceeded: Entry size ${entrySize} bytes exceeds max entry size of ${maxEntrySize} bytes`,
            "MAX_ENTRY_SIZE_EXCEEDED",
            { entrySize, maxEntrySize },
        );
    }
}

export class MaxCacheSizeExceededError extends DynCacheError {
    constructor(cacheSize: number, maxCacheSize: number) {
        super(
            `Max cache size exceeded: Cache size ${cacheSize} bytes exceeds max cache size of ${maxCacheSize} bytes`,
            "MAX_CACHE_SIZE_EXCEEDED",
            { cacheSize, maxCacheSize },
        );
    }
}

export class MaxCacheLengthExceededError extends DynCacheError {
    constructor(cacheLength: number, maxCacheLength: number) {
        super(
            `Max cache length exceeded: Cache length ${cacheLength} exceeds max cache length of ${maxCacheLength}`,
            "MAX_CACHE_LENGTH_EXCEEDED",
            { cacheLength, maxCacheLength },
        );
    }
}

export class InvalidDynCacheOptionsError extends DynCacheError {
    constructor(message: string, details: Record<string, unknown> = {}) {
        super(message, "INVALID_DYN_CACHE_OPTIONS", details);
    }
}
