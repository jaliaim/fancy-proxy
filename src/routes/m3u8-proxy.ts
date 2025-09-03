import { setResponseHeaders, getQuery, sendError, createError, getRequestHost, getRequestProtocol, defineEventHandler, isPreflightRequest, handleCors } from 'h3';
import { LRUCache } from '@/utils/lru-cache';
import { pooledRequest } from '@/utils/connection-pool';

// Check if caching is disabled via environment variable
const isCacheDisabled = () => process.env.DISABLE_CACHE === 'true';

function parseURL(req_url: string, baseUrl?: string) {
  if (baseUrl) {
    return new URL(req_url, baseUrl).href;
  }
  
  const match = req_url.match(/^(?:(https?:)?\/\/)?(([^\/?]+?)(?::(\d{0,5})(?=[\/?]|$))?)([\/?][\S\s]*|$)/i);
  
  if (!match) {
    return null;
  }
  
  if (!match[1]) {
    if (/^https?:/i.test(req_url)) {
      return null;
    }
    
    // Scheme is omitted
    if (req_url.lastIndexOf("//", 0) === -1) {
      // "//" is omitted
      req_url = "//" + req_url;
    }
    req_url = (match[4] === "443" ? "https:" : "http:") + req_url;
  }
  
  try {
    const parsed = new URL(req_url);
    if (!parsed.hostname) {
      // "http://:1/" and "http:/notenoughslashes" could end up here
      return null;
    }
    return parsed.href;
  } catch (error) {
    return null;
  }
}

const CACHE_MAX_SIZE = 2000;
const CACHE_MAX_MEMORY_BYTES = 500 * 1024 * 1024; // 500MB memory limit
const CACHE_EXPIRY_MS = 2 * 60 * 60 * 1000;
const segmentCache = new LRUCache<string, Uint8Array>(CACHE_MAX_SIZE, CACHE_MAX_MEMORY_BYTES, CACHE_EXPIRY_MS);

function cleanupCache() {
  const removedCount = segmentCache.cleanup();
  
  if (removedCount > 0) {
    console.log(`Cleaned up ${removedCount} expired cache entries. Current size: ${segmentCache.size}`);
  }
  
  return segmentCache.size;
}

let cleanupInterval: any = null;
function startCacheCleanupInterval() {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupCache, 30 * 60 * 1000);
    console.log('Started periodic cache cleanup interval');
  }
}

startCacheCleanupInterval();

async function prefetchSegment(url: string, headers: HeadersInit) {
  // Skip prefetching if cache is disabled
  if (isCacheDisabled()) {
    return;
  }
  
  const existing = segmentCache.get(url);
  if (existing) {
    return; // LRU cache handles expiration automatically
  }
  
  try {
    const response = await pooledRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...(headers as HeadersInit),
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to prefetch TS segment: ${response.status} ${response.statusText}`);
      return;
    }
    
    const data = new Uint8Array(await response.arrayBuffer());
    
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    segmentCache.set(url, data, responseHeaders);
    
    console.log(`Prefetched and cached segment: ${url}`);
  } catch (error) {
    console.error(`Error prefetching segment ${url}:`, error);
  }
}

export function getCachedSegment(url: string) {
  // Return undefined immediately if cache is disabled
  if (isCacheDisabled()) {
    return undefined;
  }
  
  return segmentCache.get(url);
}

export function getCacheStats() {
  return segmentCache.getStats();
}

/**
 * Proxies m3u8 files and replaces the content to point to the proxy
 */
async function proxyM3U8(event: any) {
  const url = getQuery(event).url as string;
  const headersParam = getQuery(event).headers as string;
  
  if (!url) {
    return sendError(event, createError({
      statusCode: 400,
      statusMessage: 'URL parameter is required'
    }));
  }
  
  let headers = {};
  try {
    headers = headersParam ? JSON.parse(headersParam) : {};
  } catch (e) {
    return sendError(event, createError({
      statusCode: 400,
      statusMessage: 'Invalid headers format'
    }));
  }
  
  try {
    const response = await pooledRequest(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0',
        ...(headers as HeadersInit),
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`Failed to fetch M3U8: ${response.status} ${response.statusText} for URL: ${url}`);
      console.error(`Response body: ${errorText}`);
      throw new Error(`Failed to fetch M3U8: ${response.status} ${response.statusText}`);
    }
    
    const m3u8Content = await response.text();
    
    // Get the base URL for the host
    const host = getRequestHost(event);
    const proto = getRequestProtocol(event);
    const baseProxyUrl = `${proto}://${host}`;
    
    if (m3u8Content.includes("RESOLUTION=")) {
      // This is a master playlist with multiple quality variants
      const lines = m3u8Content.split("\n");
      const newLines: string[] = [];
      
      for (const line of lines) {
        if (line.startsWith("#")) {
          if (line.startsWith("#EXT-X-KEY:")) {
            // Proxy the key URL
            const regex = /https?:\/\/[^\""\s]+/g;
            const keyUrl = regex.exec(line)?.[0];
            if (keyUrl) {
              const proxyKeyUrl = `${baseProxyUrl}/ts-proxy?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
              newLines.push(line.replace(keyUrl, proxyKeyUrl));
            } else {
              newLines.push(line);
            }
          } else if (line.startsWith("#EXT-X-MEDIA:")) {
            // Proxy alternative media URLs (like audio streams)
            const regex = /https?:\/\/[^\""\s]+/g;
            const mediaUrl = regex.exec(line)?.[0];
            if (mediaUrl) {
              const proxyMediaUrl = `${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(mediaUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
              newLines.push(line.replace(mediaUrl, proxyMediaUrl));
            } else {
              newLines.push(line);
            }
          } else {
            newLines.push(line);
          }
        } else if (line.trim()) {
          // This is a quality variant URL
          const variantUrl = parseURL(line, url);
          if (variantUrl) {
            newLines.push(`${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(variantUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
          } else {
            newLines.push(line);
          }
        } else {
          // Empty line, preserve it
          newLines.push(line);
        }
      }
      
      // Set appropriate headers
      setResponseHeaders(event, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      
      return newLines.join("\n");
    } else {
      // This is a media playlist with segments
      const lines = m3u8Content.split("\n");
      const newLines: string[] = [];
      
      const segmentUrls: string[] = [];
      
      for (const line of lines) {
        if (line.startsWith("#")) {
          if (line.startsWith("#EXT-X-KEY:")) {
            // Proxy the key URL
            const regex = /https?:\/\/[^\""\s]+/g;
            const keyUrl = regex.exec(line)?.[0];
            if (keyUrl) {
              const proxyKeyUrl = `${baseProxyUrl}/ts-proxy?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
              newLines.push(line.replace(keyUrl, proxyKeyUrl));
              
              // Only prefetch if cache is enabled
              if (!isCacheDisabled()) {
                prefetchSegment(keyUrl, headers as HeadersInit);
              }
            } else {
              newLines.push(line);
            }
          } else {
            newLines.push(line);
          }
        } else if (line.trim() && !line.startsWith("#")) {
          // This is a segment URL (.ts file)
          const segmentUrl = parseURL(line, url);
          if (segmentUrl) {
            segmentUrls.push(segmentUrl);
            
            newLines.push(`${baseProxyUrl}/ts-proxy?url=${encodeURIComponent(segmentUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
          } else {
            newLines.push(line);
          }
        } else {
          // Comment or empty line, preserve it
          newLines.push(line);
        }
      }
      
      if (segmentUrls.length > 0) {
        console.log(`Starting to prefetch ${segmentUrls.length} segments for ${url}`);
        
        // Only perform cache operations if cache is enabled
        if (!isCacheDisabled()) {
          cleanupCache();
          
          // Prefetch all segments without concurrency limiting
          Promise.all(segmentUrls.map(segmentUrl =>
            prefetchSegment(segmentUrl, headers as HeadersInit)
          )).catch(error => {
            console.error('Error prefetching segments:', error);
          });
        } else {
          console.log('Cache disabled - skipping prefetch operations');
        }
      }
      
      // Set appropriate headers
      setResponseHeaders(event, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      
      return newLines.join("\n");
    }
  } catch (error: any) {
    console.error('Error proxying M3U8:', error);
    return sendError(event, createError({
      statusCode: 500,
      statusMessage: error.message || 'Error proxying M3U8 file'
    }));
  }
}

export function handleCacheStats(event: any) {
  cleanupCache();
  setResponseHeaders(event, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
  return getCacheStats();
}

export default defineEventHandler(async (event) => {
  // Handle CORS preflight requests
  if (isPreflightRequest(event)) return handleCors(event, {});

  if (process.env.DISABLE_M3U8 === 'true') {
    return sendError(event, createError({
      statusCode: 404,
      statusMessage: 'M3U8 proxying is disabled'
    }));
  }
  
  if (event.path === '/cache-stats') {
    return handleCacheStats(event);
  }
  
  return await proxyM3U8(event);
});
