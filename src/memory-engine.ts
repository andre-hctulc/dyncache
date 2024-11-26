import { DynCacheEngine } from "./types.js";

export class MemoryEngine implements DynCacheEngine {
    private _cache: Record<string, any> = {};

    setValue(key: string, value: any): void {
        this._cache[key] = value;
    }

    getValue(key: string): any {
        return this._cache[key];
    }

    allKeys(): string[] {
        return Object.keys(this._cache);
    }

    remove(key: string): void {
        delete this._cache[key];
    }
}
