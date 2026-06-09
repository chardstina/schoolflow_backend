/**
 * In-memory Redis shim — drop-in replacement for the `redis` package.
 * Works without any Redis installation. TTL expiry is handled via setTimeout.
 * Swap this file for a real Redis client when deploying to production.
 */

interface Entry {
  value: string;
  timer?: ReturnType<typeof setTimeout>;
}

const store = new Map<string, Entry>();

function _del(key: string) {
  const entry = store.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  store.delete(key);
}

export const redis = {
  isOpen: true,

  async get(key: string): Promise<string | null> {
    return store.get(key)?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    _del(key);
    store.set(key, { value });
  },

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    _del(key);
    const timer = setTimeout(() => store.delete(key), ttlSeconds * 1000);
    store.set(key, { value, timer });
  },

  async del(key: string): Promise<void> {
    _del(key);
  },

  async incr(key: string): Promise<number> {
    const current = parseInt(store.get(key)?.value ?? '0', 10);
    const next = current + 1;
    const entry = store.get(key);
    store.set(key, { value: String(next), timer: entry?.timer });
    return next;
  },

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = store.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => store.delete(key), ttlSeconds * 1000);
  },

  on(_event: string, _handler: (...args: any[]) => void) {
    // no-op — keeps compatibility with redis client event API
    return this;
  },
};
