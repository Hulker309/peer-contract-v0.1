// peer-contract-enforcer acceptance criteria cache (HR7 immutable-AC-by-worker)
// Day 4: in-memory cache with TTL + session_end eviction (Kelsen acCache lifecycle feedback).
//
// Lifecycle:
//   set(cardId, ac, opts?)        — opts.ttl ms; default no expiry. recordAc(cache, cardId, AC) at bus dispatch.
//   get(cardId)                   — returns AC or undefined (auto-purges if past ttl).
//   evict(cardId)                 — manual eviction (e.g. session_end hook for work sessions).
//   evictByAgent(agentId)         — bulk evict by owner agentId (for cleanup on session_end patterns).
//   has(cardId)                   — peek without consuming.
//   size                          — total cache entries (informational).
//
// Persistence: Day 6 will persist to workboard card metadata (bus_work_relations field) for restart survival.

/**
 * @typedef {Object} CacheEntry
 * @property {string} ac
 * @property {number} createdAt   — ms epoch
 * @property {number} expiresAt   — ms epoch (0 = no expiry)
 * @property {string} setBy       — sessionKey of dispatcher (audit trail)
 * @property {string} [agentId]   — owning agent (for bulk eviction)
 */

/**
 * @typedef {Object} AcCacheOptions
 * @property {number} [defaultTtlMs] — default TTL for set() when no per-call ttl given). 0 = no expiry.
 * @property {number} [maxSize]     — LRU cap. 0 = unbounded. Default 1000.
 */

export function createAcceptanceCriteriaCache(options = {}) {
  /** @type {Map<string, CacheEntry>} */
  const map = new Map();
  const defaultTtlMs = options.defaultTtlMs ?? 0;
  const maxSize = options.maxSize ?? 1000;

  function purgeIfExpired(cardId) {
    const entry = map.get(cardId);
    if (!entry) return undefined;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      map.delete(cardId);
      return undefined;
    }
    return entry;
  }

  return {
    /**
     * @param {string} cardId
     * @param {string} ac
     * @param {{ ttlMs?: number, setBy?: string, agentId?: string }} [opts]
     */
    set(cardId, ac, opts = {}) {
      if (!cardId || typeof ac !== "string") return;
      // LRU eviction if at cap and key is new
      if (maxSize > 0 && !map.has(cardId) && map.size >= maxSize) {
        // Evict oldest by createdAt
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [k, v] of map) {
          if (v.createdAt < oldestAt) {
            oldestAt = v.createdAt;
            oldestKey = k;
          }
        }
        if (oldestKey) map.delete(oldestKey);
      }
      const ttlMs = opts.ttlMs ?? defaultTtlMs;
      map.set(cardId, {
        ac,
        createdAt: Date.now(),
        expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
        setBy: opts.setBy ?? "unknown",
        agentId: opts.agentId,
      });
    },
    /**
     * @param {string} cardId
     * @returns {string | undefined}
     */
    get(cardId) {
      const entry = purgeIfExpired(cardId);
      return entry?.ac;
    },
    /**
     * @param {string} cardId
     * @returns {boolean}
     */
    has(cardId) {
      return purgeIfExpired(cardId) !== undefined;
    },
    /**
     * @param {string} cardId
     */
    evict(cardId) {
      map.delete(cardId);
    },
    /**
     * Evict all entries owned by a given agentId (used on session_end patterns).
     * @param {string} agentId
     * @returns {number} count of eved entries
     */
    evictByAgent(agentId) {
      let count = 0;
      for (const [k, v] of map) {
        if (v.agentId === agentId) {
          map.delete(k);
          count++;
        }
      }
      return count;
    },
    /**
     * Purge all expired entries (sweep).
     * @returns {number} count of purged entries
     */
    purgeExpired() {
      let count = 0;
      const now = Date.now();
      for (const [k, v] of map) {
        if (v.expiresAt > 0 && now > v.expiresAt) {
          map.delete(k);
          count++;
        }
      }
      return count;
    },
    get size() {
      return map.size;
    },
    /** For tests / debugging */
    _memMap: map,
  };
}