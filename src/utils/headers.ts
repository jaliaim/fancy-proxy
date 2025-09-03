const headerMap: Record<string, string> = {
  'X-Cookie': 'Cookie',
  'X-Referer': 'Referer',
  'X-Origin': 'Origin',
  'X-User-Agent': 'User-Agent',
  'X-X-Real-Ip': 'X-Real-Ip',
};

// Precompute blacklisted headers as a Set for O(1) lookups
const blacklistedHeaders = [
  'cf-connecting-ip',
  'cf-worker',
  'cf-ray',
  'cf-visitor',
  'cf-ew-via',
  'cdn-loop',
  'x-amzn-trace-id',
  'cf-ipcountry',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'content-length',
  ...Object.keys(headerMap),
];

// Create a Set for case-insensitive lookups
const BLACKLISTED_HEADERS_SET = new Set(
  blacklistedHeaders.map(h => h.toLowerCase())
);

// Cache the default user agent to avoid recreating the string
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0';

function copyHeader(
  headers: Headers,
  outputHeaders: Headers,
  inputKey: string,
  outputKey: string,
) {
  // Optimized to use a single operation instead of has() + get()
  const value = headers.get(inputKey);
  if (value !== null) {
    outputHeaders.set(outputKey, value);
  }
}

export function getProxyHeaders(headers: Headers): Headers {
  const output = new Headers();

  // Use cached user agent string
  output.set('User-Agent', DEFAULT_USER_AGENT);

  // Use for...of loop instead of forEach for better performance
  for (const [inputKey, outputKey] of Object.entries(headerMap)) {
    copyHeader(headers, output, inputKey, outputKey);
  }

  return output;
}

export function getAfterResponseHeaders(
  headers: Headers,
  finalUrl: string,
): Record<string, string> {
  const output: Record<string, string> = {};

  if (headers.has('Set-Cookie'))
    output['X-Set-Cookie'] = headers.get('Set-Cookie') ?? '';

  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin',
    'X-Final-Destination': finalUrl,
    ...output,
  };
}

export function getBlacklistedHeaders() {
  return blacklistedHeaders;
}

// Optimized function to filter headers using the precomputed Set
export function filterHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  
  // Use for...of loop instead of entries() for better performance
  for (const [key, value] of headers) {
    if (!BLACKLISTED_HEADERS_SET.has(key.toLowerCase())) {
      filtered.set(key, value);
    }
  }
  
  return filtered;
}
