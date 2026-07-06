import { AsyncDynCache } from "../src/async-dyn-cache.js";
import { createEntry, hash } from "../src/system.js";
import type { DynCacheEngine } from "../src/types.js";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

class ControlledAsyncEngine implements DynCacheEngine {
    readonly store = new Map<string, any>();
    readonly getGate = deferred<void>();
    readonly setGate = deferred<void>();
    readonly setStarted = deferred<void>();
    getCalls = 0;
    setCalls = 0;
    removeCalls = 0;

    setValue(key: string, value: any): Promise<void> {
        this.setCalls++;
        this.setStarted.resolve();
        return this.setGate.promise.then(() => {
            this.store.set(key, value);
        });
    }

    getValue(key: string): Promise<any> {
        this.getCalls++;
        return this.getGate.promise.then(() => this.store.get(key));
    }

    allKeys(): Promise<string[]> {
        return Promise.resolve([...this.store.keys()]);
    }

    removeValue(key: string): Promise<void> {
        this.removeCalls++;
        this.store.delete(key);
        return Promise.resolve();
    }
}

describe("AsyncDynCache concurrency", () => {
    it("reuses active gets for the same key", async () => {
        const engine = new ControlledAsyncEngine();
        const cache = new AsyncDynCache({ engine });
        const key = "project";
        const entry = createEntry(key, { id: 1 }, Number.POSITIVE_INFINITY, {});

        engine.store.set(hash(key), entry);

        try {
            const first = cache.get(key);
            const second = cache.get(key);

            expect(engine.getCalls).toBe(1);

            engine.getGate.resolve();

            await expect(first).resolves.toEqual(entry.value);
            await expect(second).resolves.toEqual(entry.value);
        } finally {
            cache.deactivate(true);
        }
    });

    it("keeps the latest concurrent set for the same key", async () => {
        const engine = new ControlledAsyncEngine();
        const cache = new AsyncDynCache({ engine });

        engine.getGate.resolve();

        try {
            const first = cache.set("project", "first");
            await engine.setStarted.promise;
            const second = cache.set("project", "second");

            expect(engine.setCalls).toBe(1);

            engine.setGate.resolve();

            await expect(first).resolves.toBeDefined();
            await expect(second).resolves.toBeDefined();
            await expect(cache.get("project")).resolves.toBe("second");
        } finally {
            cache.deactivate(true);
        }
    });

    it("cancels an in-flight set when clear runs", async () => {
        const engine = new ControlledAsyncEngine();
        const cache = new AsyncDynCache({ engine });

        engine.getGate.resolve();

        try {
            const setPromise = cache.set("project", "value");

            await engine.setStarted.promise;
            await cache.clear();

            engine.setGate.resolve();

            await expect(setPromise).resolves.toBeDefined();
            await expect(cache.get("project")).resolves.toBeUndefined();
            expect(engine.store.has(hash("project"))).toBe(false);
        } finally {
            cache.deactivate(true);
        }
    });
});
