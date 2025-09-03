import {
  H3Event,
  Duplex,
  ProxyOptions,
  getProxyRequestHeaders,
  RequestHeaders,
  getRequestWebStream,
  readRawBody,
  sendProxy,
} from 'h3';
import { filterHeaders } from './headers';

const PayloadMethods = new Set(['PATCH', 'POST', 'PUT', 'DELETE']);

export interface ExtraProxyOptions {
  blacklistedHeaders?: string[];
}

function mergeHeaders(
  defaults: HeadersInit,
  ...inputs: (HeadersInit | RequestHeaders | undefined)[]
) {
  const _inputs = inputs.filter(Boolean) as HeadersInit[];
  if (_inputs.length === 0) {
    return defaults;
  }
  const merged = new Headers(defaults);
  for (const input of _inputs) {
    if (input.entries) {
      for (const [key, value] of (input.entries as any)()) {
        if (value !== undefined) {
          merged.set(key, value);
        }
      }
    } else {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
          merged.set(key, value);
        }
      }
    }
  }
  return merged;
}

export async function specificProxyRequest(
  event: H3Event,
  target: string,
  opts: ProxyOptions & ExtraProxyOptions = {},
) {
  let body;
  let duplex: Duplex | undefined;
  if (PayloadMethods.has(event.method)) {
    if (opts.streamRequest) {
      body = getRequestWebStream(event);
      duplex = 'half';
    } else {
      body = await readRawBody(event, false).catch(() => undefined);
    }
  }

  const method = opts.fetchOptions?.method || event.method;
  let oldHeaders = getProxyRequestHeaders(event);

  // netlify seems to be changing the content-encoding header to gzip when the reponse is encoded in zstd
  // so as temp fix just not sending zstd in accept encoding
  if (oldHeaders['accept-encoding']?.includes('zstd'))
    oldHeaders['accept-encoding'] = oldHeaders['accept-encoding']
      .split(',')
      .map((x: string) => x.trim())
      .filter((x: string) => x !== 'zstd')
      .join(', ');

  // Use optimized header filtering if blacklistedHeaders are provided
  if (opts.blacklistedHeaders && opts.blacklistedHeaders.length > 0) {
    const headersObj = new Headers();
    // Convert oldHeaders object to Headers
    for (const [key, value] of Object.entries(oldHeaders)) {
      headersObj.set(key, value as string);
    }
    
    // Filter headers using our optimized function
    const filteredHeaders = filterHeaders(headersObj);
    
    // Convert back to object
    const filteredObj: Record<string, string> = {};
    for (const [key, value] of filteredHeaders.entries()) {
      filteredObj[key] = value;
    }
    
    // Replace oldHeaders with filtered version
    oldHeaders = filteredObj;
  }

  const fetchHeaders = mergeHeaders(
    oldHeaders,
    opts.fetchOptions?.headers,
    opts.headers,
  );
  const headerObj = Object.fromEntries([...(fetchHeaders.entries as any)()]);
  if (process.env.REQ_DEBUG === 'true') {
    console.log({
      type: 'request',
      method,
      url: target,
      headers: headerObj,
    });
  }

  return sendProxy(event, target, {
    ...opts,
    fetchOptions: {
      method,
      body: body as BodyInit,
      duplex,
      ...opts.fetchOptions,
      headers: fetchHeaders,
    },
  });
}
