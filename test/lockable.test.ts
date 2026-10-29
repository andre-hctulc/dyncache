import { describe, expect, it, jest } from "@jest/globals";
import { DynCache } from "../src/index.js";
import { MaxEntrySizeExceededError } from "../src/errors.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("DynCache locks", () => {
    it("supports forced reloads", async () => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        const gate = deferred<string>();
        const entry = cache.set("key", "cached", { ttl: 5000, refresh: true });
        const expiresAt = entry.expiresAt;
        const getEntry = jest.spyOn(cache, "getEntry");
        const factory = jest.fn(() => gate.promise);
        const pending = cache.lock("key", factory, { noRead: true });

        expect(getEntry).not.toHaveBeenCalled();
        expect(entry.expiresAt).toBe(expiresAt);
        expect(cache.get("key", { refresh: false })).toBe("cached");
        const reader = cache.lockGet("key");
        gate.resolve("fresh");

        await expect(pending).resolves.toBe("fresh");
        await expect(reader).resolves.toBe("fresh");
        expect(factory).toHaveBeenCalledTimes(1);
        expect(cache.get("key")).toBe("fresh");
        expect(cache.getLength()).toBe(1);
    });

    it("shares an active reload with normal and forced callers", async () => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        const gate = deferred<string>();
        cache.set("key", "cached");
        const pending = cache.lock("key", () => gate.promise, { noRead: true });
        const ignored = jest.fn(() => "wrong");

        expect(cache.lock("key", ignored)).toBe(pending);
        expect(cache.lock("key", ignored, { noRead: true })).toBe(pending);
        gate.resolve("fresh");
        await pending;
        expect(ignored).not.toHaveBeenCalled();
    });

    it("retains the cached value after a failed forced reload and allows retry", async () => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        cache.set("key", "cached");
        const failure = new Error("reload failed");

        await expect(cache.lock("key", () => Promise.reject(failure), { noRead: true })).rejects.toBe(failure);
        expect(cache.get("key")).toBe("cached");
        await expect(cache.lock("key", () => "fresh", { noRead: true })).resolves.toBe("fresh");
        expect(cache.get("key")).toBe("fresh");
    });

    it("returns cached falsy values without invoking factories", async () => {
        const cache = new DynCache<string, number | undefined>({ clearIntervalLength: 0 });
        const factory = jest.fn(() => 42);
        cache.set("zero", 0);
        cache.set("undefined", undefined);
        await expect(cache.lock("zero", factory)).resolves.toBe(0);
        await expect(cache.lock("undefined", factory)).resolves.toBeUndefined();
        await expect(cache.lockGet("zero")).resolves.toBe(0);
        await expect(cache.lockGet("missing")).resolves.toBeUndefined();
        expect(factory).not.toHaveBeenCalled();
    });

    it("deduplicates equivalent object keys and makes lockGet wait for the value", async () => {
        const cache = new DynCache<{ id: number }, string>({ clearIntervalLength: 0 });
        const gate = deferred<string>();
        const firstFactory = jest.fn(() => gate.promise);
        const secondFactory = jest.fn(() => "wrong");
        const first = cache.lock({ id: 1 }, firstFactory);
        const second = cache.lock({ id: 1 }, secondFactory);
        const reader = cache.lockGet({ id: 1 });
        const read = jest.fn();
        void reader.then(read);

        expect(second).toBe(first);
        expect(firstFactory).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(firstFactory).toHaveBeenCalledTimes(1);
        expect(secondFactory).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(cache.get({ id: 1 })).toBeUndefined();
        gate.resolve("loaded");
        await expect(first).resolves.toBe("loaded");
        await expect(reader).resolves.toBe("loaded");
        expect(cache.getLength()).toBe(1);
    });

    it("allows unrelated keys to load independently", async () => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        const gate = deferred<string>();
        const slow = cache.lock("slow", () => gate.promise);
        await expect(cache.lock("fast", async () => "fast")).resolves.toBe("fast");
        gate.resolve("slow");
        await expect(slow).resolves.toBe("slow");
    });

    it("deduplicates synchronous factories and caches undefined as an entry", async () => {
        const cache = new DynCache<string, undefined>({ clearIntervalLength: 0 });
        const factory = jest.fn(() => undefined);
        const first = cache.lock("key", factory);
        const second = cache.lock("key", factory);
        expect(first).toBe(second);
        await Promise.all([first, second]);
        await cache.lock("key", factory);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(cache.has("key")).toBe(true);
    });

    it.each(["throw", "reject"] as const)("releases locks and propagates errors on %s", async (mode) => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        const failure = new Error("load failed");
        const pending = cache.lock("key", () => {
            if (mode === "throw") {
                throw failure;
            }
            return Promise.reject(failure);
        });
        const reader = cache.lockGet("key");
        await Promise.all([
            expect(pending).rejects.toBe(failure),
            expect(reader).rejects.toBe(failure),
        ]);
        await expect(cache.lock("key", () => "retry")).resolves.toBe("retry");
        expect(cache.get("key")).toBe("retry");
    });

    it("uses normal cache limits and callbacks and releases locks on write errors", async () => {
        const onSet = jest.fn();
        const cache = new DynCache<string, string>({
            clearIntervalLength: 0,
            maxEntrySize: 400,
            entryOptions: { tags: ["loaded"], ttl: 5000 },
            onSet,
        });
        await expect(cache.lock("key", () => "x".repeat(1000))).rejects.toThrow(MaxEntrySizeExceededError);
        expect(cache.has("key")).toBe(false);
        await expect(cache.lock("key", () => "small")).resolves.toBe("small");
        const entry = cache.getEntry("key");
        expect(entry?.tags).toEqual(["loaded"]);
        expect(entry?.ttl).toBe(5000);
        expect(cache.getSize()).toBe(entry?.size);
        expect(onSet).toHaveBeenCalledTimes(1);
    });

    it("retrieves a new value when a cached entry is expired", async () => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        const entry = cache.set("key", "expired");
        entry.expiresAt = Date.now() - 1;
        await expect(cache.lock("key", () => "fresh")).resolves.toBe("fresh");
        expect(cache.get("key")).toBe("fresh");
        expect(cache.getLength()).toBe(1);
    });

    it.each(["set", "remove", "clear", "deactivate"] as const)(
        "%s prevents a pending retrieval from writing stale data",
        async (operation) => {
            const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
            const gate = deferred<string>();
            const pending = cache.lock("key", () => gate.promise);
            const reader = cache.lockGet("key");
            await Promise.resolve();
            if (operation === "set") {
                cache.set("key", "manual");
            } else if (operation === "remove") {
                cache.remove("key");
            } else {
                cache[operation]();
            }
            gate.resolve("stale");
            await expect(pending).resolves.toBe("stale");
            const expected = operation === "set" ? "manual" : undefined;
            await expect(reader).resolves.toBe(expected);
            expect(cache.get("key")).toBe(expected);
        },
    );

    it("does not let completion of an invalidated lock clear a newer lock", async () => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        const oldGate = deferred<string>();
        const newGate = deferred<string>();
        const oldLock = cache.lock("key", () => oldGate.promise);
        const reader = cache.lockGet("key");
        cache.remove("key");
        const newLock = cache.lock("key", () => newGate.promise);
        oldGate.resolve("old");
        await expect(oldLock).resolves.toBe("old");
        expect(cache.get("key")).toBeUndefined();
        expect(cache.lock("key", () => "wrong")).toBe(newLock);
        newGate.resolve("new");
        await expect(newLock).resolves.toBe("new");
        await expect(reader).resolves.toBe("new");
        expect(cache.get("key")).toBe("new");
    });

    it("preserves pending retrievals on deactivate(true)", async () => {
        const cache = new DynCache<string, string>({ clearIntervalLength: 0 });
        const gate = deferred<string>();
        const pending = cache.lock("key", () => gate.promise);
        cache.deactivate(true);
        gate.resolve("loaded");
        await pending;
        expect(cache.get("key")).toBe("loaded");
    });

    it("does not leave a lock behind when onSet throws", async () => {
        const failure = new Error("onSet failed");
        const onSet = jest.fn((): void => { throw failure; });
        const cache = new DynCache<string, string>({ clearIntervalLength: 0, onSet });
        await expect(cache.lock("key", () => "value")).rejects.toBe(failure);
        await expect(cache.lockGet("key")).resolves.toBe("value");
        cache.remove("key");
        onSet.mockImplementation(() => {});
        await expect(cache.lock("key", () => "retry")).resolves.toBe("retry");
    });
});
