/**
 * Connection pool for HTTP requests to improve performance
 */
import { Pool, Dispatcher } from 'undici';
import { Readable } from 'stream';

interface PoolOptions {
  connections: number;
  pipelining: number;
  keepAliveTimeout: number;
}

const DEFAULT_POOL_OPTIONS: PoolOptions = {
  connections: 10,    // Max connections per pool
  pipelining: 5,      // Max pipelined requests per connection
  keepAliveTimeout: 30000, // 30 seconds
};

class ConnectionPoolManager {
  private pools = new Map<string, Pool>();
  private options: PoolOptions;
  
  constructor(options: Partial<PoolOptions> = {}) {
    this.options = { ...DEFAULT_POOL_OPTIONS, ...options };
  }
  
  /**
   * Get or create a connection pool for the given origin
   */
  getPool(origin: string): Pool {
    if (!this.pools.has(origin)) {
      this.pools.set(origin, new Pool(origin, this.options));
    }
    return this.pools.get(origin)!;
  }
  
  /**
   * Close all connection pools
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.pools.values()).map(pool => pool.close());
    await Promise.all(closePromises);
    this.pools.clear();
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const stats: Record<string, any> = {};
    for (const [origin, pool] of this.pools.entries()) {
      // Note: undici Pool doesn't expose these properties directly in the TypeScript types
      // We'll provide basic information
      stats[origin] = {
        origin: origin,
        // The actual stats would need to be accessed through internal properties if available
      };
    }
    return stats;
  }
}

// Create a global connection pool manager instance
export const connectionPoolManager = new ConnectionPoolManager();

/**
 * Make a request using the connection pool
 */
export async function pooledRequest(
  url: string,
  options: RequestInit & { poolOptions?: Partial<PoolOptions> } = {}
): Promise<Response> {
  const parsedUrl = new URL(url);
  const pool = connectionPoolManager.getPool(parsedUrl.origin);
  
  const { poolOptions, ...fetchOptions } = options;
  
  try {
    const response = await pool.request({
      path: parsedUrl.pathname + parsedUrl.search,
      method: (fetchOptions.method || 'GET') as Dispatcher.HttpMethod,
      headers: fetchOptions.headers as Record<string, string> || {},
      body: fetchOptions.body as any,
      opaque: fetchOptions,
    });
    
    // Convert undici response to web Response
    return new Response(response.body as any, {
      status: response.statusCode,
      statusText: '', // statusText is not available in undici response
      headers: new Headers(response.headers as Record<string, string>),
    });
  } catch (error) {
    console.error(`Connection pool request failed for ${url}:`, error);
    // Fallback to regular fetch if pool request fails
    return fetch(url, fetchOptions);
  }
}