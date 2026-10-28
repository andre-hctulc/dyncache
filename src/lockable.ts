export type LockFn<V> = () => Awaited<V> | Promise<V>;

export interface Lockable<K, V> {
    /**
     * Return a cached value or retrieve and cache it once per key.
     * Concurrent calls share the first retrieval, including its errors.
     * Use {@link lockGet} to retrieve the value while respecting the lock.
     */
    lock(key: K, fn: LockFn<V>): Promise<Awaited<V>>;

    /**
     * Wait for active retrievals, then return the current cached value.
     * Rejects if a retrieval fails. Does not start a retrieval on a miss.
     */
    lockGet(key: K): Promise<V | undefined>;
}
