import { InvalidDynCacheOptionsError } from "./errors.js";
import { isExpired, runSafely } from "./system.js";
import type { DynCacheConfig, DynCacheEntry, MaybePromise } from "./types.js";

export abstract class BaseDynCache<BK = any, BV = any> {
    #clearAbortController = new AbortController();
    #clearIntervalRef: any;
    #conf: DynCacheConfig<BK, BV>;

    constructor(config: DynCacheConfig<BK, BV> = {}) {
        this.#conf = config;

        const maxSize = config.maxSize || Infinity;
        const maxEntries = config.maxEntries || Infinity;
        const maxEntrySize = config.maxEntrySize || config.maxSize || Infinity;

        if (maxSize < 0) {
            throw new InvalidDynCacheOptionsError("Max memory size must be a positive number or Infinity");
        }
        if (maxEntries < 0) {
            throw new InvalidDynCacheOptionsError("Max entries must be a positive number or Infinity");
        }
        if (maxEntrySize < 0) {
            throw new InvalidDynCacheOptionsError("Max entry size must be a positive number or Infinity");
        }
        if (maxEntrySize > maxSize) {
            throw new InvalidDynCacheOptionsError("Max entry size cannot be larger than max cache size");
        }

        this.#startClearInterval();
    }

    #startClearInterval() {
        const clear = () => {
            runSafely(
                () => this.#removeExpired(),
                (err) => {
                    console.error("Error occurred while clearing expired entries from cache", err);
                },
            );
        };

        if (this.#conf.clearIntervalLength === 0 || this.#conf.clearIntervalLength === Infinity) {
            return;
        }

        const intervalLength = this.#conf.clearIntervalLength || 300000;

        if (this.#conf.startClearInterval) {
            this.#conf.startClearInterval(intervalLength, clear, this.#clearAbortController.signal);
        } else {
            this.#clearIntervalRef = setInterval(() => {
                clear();
            }, intervalLength);
        }

        this.#clearAbortController.signal.addEventListener("abort", () => {
            if (this.#clearIntervalRef) {
                clearInterval(this.#clearIntervalRef);
                this.#clearIntervalRef = null;
            }
        });
    }

    abstract getSize(): number;

    abstract getLength(): number;

    abstract remove(key: any): MaybePromise<any>;

    abstract all(): MaybePromise<DynCacheEntry<BK, BV>[]>;

    abstract clear(): MaybePromise<void>;

    async #removeExpired() {
        const now = Date.now();
        const entries = await this.all();
        for (const entry of entries) {
            if (isExpired(now, entry)) {
                await this.remove(entry.key);
            }
        }
    }

    /**
     * Deactivates the clearing interval
     */
    deactivate(noClear = false): void {
        this.#clearAbortController.abort();
        if (!noClear) {
            runSafely(
                () => this.clear(),
                (err) => {
                    console.error("Error occurred while clearing cache during deactivation", err);
                },
            );
        }
    }
}
