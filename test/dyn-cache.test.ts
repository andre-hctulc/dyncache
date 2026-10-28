import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as api from "../src/index.js";
import { DynCache } from "../src/dyn-cache.js";
import { InvalidDynCacheOptionsError, MaxEntrySizeExceededError, PromiseNotAllowedError } from "../src/errors.js";
import { MemoryEngine } from "../src/memory-engine.js";
import type { DynCacheConfig } from "../src/types.js";

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe("DynCache", () => {
    it("exports only the standalone cache class", () => {
        expect(api.DynCache).toBe(DynCache);
        expect(api).not.toHaveProperty("AsyncDynCache");
        expect(api).not.toHaveProperty("BaseDynCache");
        expect(Object.getPrototypeOf(DynCache.prototype)).toBe(Object.prototype);
    });

    it("supports synchronous access, replacement, callbacks and accounting", () => {
        const onSet = jest.fn();
        const onRemove = jest.fn();
        const cache = new DynCache({ clearIntervalLength: 0, onSet, onRemove });
        const key = { project: 1 };
        const first = cache.set(key, "first");
        const second = cache.set(key, "second");

        expect(cache.get(key)).toBe("second");
        expect(cache.getEntry(key)).toBe(second);
        expect(cache.getLength()).toBe(1);
        expect(cache.getSize()).toBe(second.size);
        expect(onRemove).toHaveBeenCalledWith(first);
        expect(onSet).toHaveBeenLastCalledWith(second, first);
        expect(cache.remove(key)).toBe(second);
        expect(cache.has(key)).toBe(false);
        expect(cache.remove(key)).toBeUndefined();
        expect(cache.getLength()).toBe(0);
        expect(cache.getSize()).toBe(0);
    });

    it("only calls the getOrSet factory on a miss", () => {
        const cache = new DynCache({ clearIntervalLength: 0 });
        const factory = jest.fn(() => 0);
        expect(cache.getOrSet("key", factory)).toBe(0);
        expect(cache.getOrSet("key", factory)).toBe(0);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("supports finders and removing matching entries", () => {
        const cache = new DynCache<string, number>({ clearIntervalLength: 0 });
        cache.set("a", 1, { tags: ["red"] });
        cache.set("b", 2, { tags: ["blue"] });
        expect(cache.find({ someTag: ["red"] }).map((entry) => entry.key)).toEqual(["a"]);
        expect(cache.find({ keys: ["b"] }).map((entry) => entry.value)).toEqual([2]);
        cache.removeByFinder((entry) => entry.value === 1);
        expect(cache.all().map((entry) => entry.key)).toEqual(["b"]);
        cache.clear();
        expect(cache.getLength()).toBe(0);
        expect(cache.getSize()).toBe(0);
    });

    it("refreshes TTL and removes expired entries on retrieval", () => {
        jest.useFakeTimers({ now: 1000 });
        const onRemove = jest.fn();
        const cache = new DynCache({
            clearIntervalLength: 0,
            entryOptions: { ttl: 100, refresh: true },
            onRemove,
        });
        const entry = cache.set("key", "value");
        jest.advanceTimersByTime(60);
        expect(cache.get("key")).toBe("value");
        expect(entry.expiresAt).toBe(1160);
        jest.advanceTimersByTime(60);
        expect(cache.get("key", { refresh: false })).toBe("value");
        jest.advanceTimersByTime(41);
        expect(cache.get("key")).toBeUndefined();
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(cache.getLength()).toBe(0);
        expect(cache.getSize()).toBe(0);
    });

    it("does not evict live entries when expiry already frees enough capacity", () => {
        jest.useFakeTimers({ now: 1000 });
        const cache = new DynCache({ clearIntervalLength: 0, maxEntries: 2 });
        cache.set("expired", "old", { ttl: 10 });
        cache.set("live", "keep");
        jest.advanceTimersByTime(11);
        cache.set("new", "value");
        expect(cache.all().map((entry) => entry.key)).toEqual(["live", "new"]);
        expect(cache.getLength()).toBe(2);
        expect(cache.getSize()).toBe(cache.all().reduce((size, entry) => size + entry.size, 0));
    });

    it("evicts by earliest expiry and preserves insertion order for ties", () => {
        jest.useFakeTimers({ now: 1000 });
        const cache = new DynCache({ clearIntervalLength: 0, maxEntries: 2 });
        cache.set("long", 1, { ttl: 200 });
        cache.set("short", 2, { ttl: 100 });
        cache.set("new", 3);
        expect(cache.has("short")).toBe(false);
        expect(cache.has("long")).toBe(true);

        cache.clear();
        cache.set("first", 1);
        cache.set("second", 2);
        cache.set("third", 3);
        expect(cache.all().map((entry) => entry.key)).toEqual(["second", "third"]);
    });

    it("enforces byte limits and leaves existing values intact on oversized replacements", () => {
        const cache = new DynCache({ clearIntervalLength: 0, maxSize: 600, maxEntrySize: 400 });
        cache.set("a", "x".repeat(100));
        cache.set("b", "x".repeat(100));
        cache.set("c", "x".repeat(100));
        expect(cache.getSize()).toBeLessThanOrEqual(600);
        expect(cache.getLength()).toBeLessThan(3);
        expect(() => cache.set("c", "x".repeat(1000))).toThrow(MaxEntrySizeExceededError);
        expect(cache.get("c")).toBe("x".repeat(100));
    });

    it("recalculates byte capacity after removing expired entries", () => {
        jest.useFakeTimers({ now: 1000 });
        const probe = new DynCache({ clearIntervalLength: 0 });
        const entrySize = probe.set("a", "value").size;
        const cache = new DynCache({ clearIntervalLength: 0, maxSize: entrySize * 2 });
        cache.set("a", "value", { ttl: 10 });
        cache.set("b", "value");
        jest.advanceTimersByTime(11);
        cache.set("c", "value");
        expect(cache.all().map((entry) => entry.key)).toEqual(["b", "c"]);
        expect(cache.getSize()).toBeLessThanOrEqual(entrySize * 2);
    });

    it.each<DynCacheConfig>([
        { maxSize: -1 },
        { maxEntries: -1 },
        { maxEntrySize: -1 },
        { maxSize: 10, maxEntrySize: 11 },
    ])("rejects invalid limits before starting cleanup: %o", (config) => {
        const startClearInterval = jest.fn<NonNullable<DynCacheConfig["startClearInterval"]>>();
        expect(() => new DynCache({ ...config, startClearInterval })).toThrow(InvalidDynCacheOptionsError);
        expect(startClearInterval).not.toHaveBeenCalled();
    });

    it("cleans expired entries on the default timer and stops it on deactivation", () => {
        jest.useFakeTimers({ now: 1000 });
        const cache = new DynCache();
        cache.set("expired", "value", { ttl: 10 });
        jest.advanceTimersByTime(300000);
        expect(cache.getLength()).toBe(0);
        cache.set("keep", "value");
        cache.deactivate(true);
        expect(jest.getTimerCount()).toBe(0);
        expect(cache.get("keep")).toBe("value");
        cache.deactivate();
        expect(cache.getLength()).toBe(0);
    });

    it("initializes the engine before a custom interval runs and aborts its signal", () => {
        let signal: AbortSignal | undefined;
        const cache = new DynCache({
            startClearInterval: (length, clear, abortSignal) => {
                expect(length).toBe(300000);
                signal = abortSignal;
                clear();
            },
        });
        expect(signal?.aborted).toBe(false);
        cache.deactivate();
        expect(signal?.aborted).toBe(true);
    });

    it.each([0, Infinity])("disables scheduled cleanup for %s", (clearIntervalLength) => {
        jest.useFakeTimers();
        const startClearInterval = jest.fn<NonNullable<DynCacheConfig["startClearInterval"]>>();
        const cache = new DynCache({ clearIntervalLength, startClearInterval });
        expect(startClearInterval).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        cache.deactivate();
    });

    it("removes expired entries without hashing or reading their keys again", () => {
        jest.useFakeTimers({ now: 1000 });
        const engine = new MemoryEngine();
        const getValue = jest.spyOn(engine, "getValue");
        const cache = new DynCache({ clearIntervalLength: 0, engine });
        cache.set("key", "value", { ttl: 10 });
        getValue.mockClear();
        jest.advanceTimersByTime(11);
        expect(cache.all()).toEqual([]);
        expect(getValue).toHaveBeenCalledTimes(1);
        expect(cache.getSize()).toBe(0);
    });

    it.each(["get", "getEntry", "set", "remove", "all", "clear"] as const)(
        "rejects promise-returning engine reads in %s",
        (method) => {
            const engine = new MemoryEngine();
            // Simulate an untyped JavaScript engine violating the synchronous contract.
            jest.spyOn(engine, "getValue").mockReturnValue(Promise.resolve(undefined));
            const cache = new DynCache({ clearIntervalLength: 0, engine });
            engine.setValue("key", {});
            expect(() => {
                if (method === "set") {
                    cache.set("key", "value");
                } else if (method === "all" || method === "clear") {
                    cache[method]();
                } else {
                    cache[method]("key");
                }
            }).toThrow(PromiseNotAllowedError);
        },
    );

    it("keeps accounting consistent if a removal callback throws during clear", () => {
        const failure = new Error("callback failure");
        const cache = new DynCache({
            clearIntervalLength: 0,
            onRemove: () => { throw failure; },
        });
        cache.set("key", "value");
        expect(() => cache.clear()).toThrow(failure);
        expect(cache.getLength()).toBe(0);
        expect(cache.getSize()).toBe(0);
    });

    it.each(["setValue", "removeValue", "allKeys"] as const)(
        "rejects promise-returning engine operation %s",
        (method) => {
            const engine = new MemoryEngine();
            const cache = new DynCache({ clearIntervalLength: 0, engine });
            cache.set("key", "value");
            Object.defineProperty(engine, method, { value: () => Promise.resolve() });
            expect(() => {
                if (method === "setValue") {
                    cache.set("new", "value");
                } else if (method === "removeValue") {
                    cache.remove("key");
                } else {
                    cache.all();
                }
            }).toThrow(PromiseNotAllowedError);
        },
    );

    it("reports rejected custom interval startup", async () => {
        const error = new Error("startup failure");
        const log = jest.spyOn(console, "error").mockImplementation(() => {});
        const cache = new DynCache({
            startClearInterval: async () => { throw error; },
        });
        await Promise.resolve();
        expect(log).toHaveBeenCalledWith("Error occurred while starting cache clearing interval", error);
        cache.deactivate();
    });
});
