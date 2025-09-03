/**
 * LRU (Least Recently Used) Cache implementation with memory tracking
 */
export interface CacheEntry<T> {
  data: T;
  headers: Record<string, string>;
  timestamp: number;
  sizeBytes: number;
}

export class LRUCache<K, T> {
  private cache = new Map<K, CacheEntry<T>>();
  private maxSize: number;
  private maxMemoryBytes: number;
  private currentMemoryBytes = 0;
  private expiryMs: number;
  
  constructor(maxSize: number, maxMemoryBytes: number, expiryMs: number) {
    this.maxSize = maxSize;
    this.maxMemoryBytes = maxMemoryBytes;
    this.expiryMs = expiryMs;
  }
  
  /**
   * Get an item from the cache, marking it as recently used
   */
  get(key: K): CacheEntry<T> | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    
    // Check if expired
    if (Date.now() - entry.timestamp > this.expiryMs) {
      this.delete(key);
      return undefined;
    }
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    return entry;
  }
  
  /**
   * Set an item in the cache, evicting items if necessary
   */
  set(key: K, data: T, headers: Record<string, string> = {}, sizeBytes?: number): void {
    // Calculate size if not provided
    const entrySize = sizeBytes || this.calculateSize(data);
    
    // Delete existing entry if it exists
    if (this.cache.has(key)) {
      this.delete(key);
    }
    
    // Evict if over memory limit
    while (this.currentMemoryBytes + entrySize > this.maxMemoryBytes && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.delete(firstKey);
      }
    }
    
    // Evict if over entry limit
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.delete(firstKey);
      }
    }
    
    // Add new entry
    const entry: CacheEntry<T> = {
      data,
      headers,
      timestamp: Date.now(),
      sizeBytes: entrySize
    };
    
    this.cache.set(key, entry);
    this.currentMemoryBytes += entrySize;
  }
  
  /**
   * Delete an item from the cache
   */
  delete(key: K): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.currentMemoryBytes -= entry.sizeBytes;
      return true;
    }
    return false;
  }
  
  /**
   * Clear all items from the cache
   */
  clear(): void {
    this.cache.clear();
    this.currentMemoryBytes = 0;
  }
  
  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.expiryMs) {
        this.delete(key);
        removedCount++;
      }
    }
    
    return removedCount;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const sizes = Array.from(this.cache.values())
      .map(entry => entry.sizeBytes);
    
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    const avgBytes = sizes.length > 0 ? totalBytes / sizes.length : 0;
    
    return {
      entries: this.cache.size,
      totalSizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
      avgEntrySizeKB: (avgBytes / 1024).toFixed(2),
      maxSize: this.maxSize,
      maxMemoryMB: (this.maxMemoryBytes / (1024 * 1024)).toFixed(2),
      currentMemoryMB: (this.currentMemoryBytes / (1024 * 1024)).toFixed(2),
      expiryHours: this.expiryMs / (60 * 60 * 1000)
    };
  }
  
  /**
   * Calculate the size of data in bytes
   */
  private calculateSize(data: T): number {
    if (data instanceof Uint8Array) {
      return data.byteLength;
    } else if (typeof data === 'string') {
      return new Blob([data]).size;
    } else if (data instanceof Blob) {
      return data.size;
    } else {
      // For other types, use a rough estimate
      return JSON.stringify(data).length * 2; // Rough estimate
    }
  }
  
  /**
   * Get the number of entries in the cache
   */
  get size(): number {
    return this.cache.size;
  }
  
  /**
   * Get cache entries for iteration
   */
  entries(): IterableIterator<[K, CacheEntry<T>]> {
    return this.cache.entries();
  }
  
  /**
   * Get cache values for iteration
   */
  values(): IterableIterator<CacheEntry<T>> {
    return this.cache.values();
  }
}