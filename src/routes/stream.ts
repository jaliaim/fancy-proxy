import { defineEventHandler, getQuery, readRawBody } from 'h3';
import { getProxyRequestHeaders } from 'h3';

export default defineEventHandler(async (event) => {
  const { destination } = getQuery(event);

  if (!destination || typeof destination !== 'string') {
    return new Response('Missing destination parameter', { status: 400 });
  }

  const body = await readRawBody(event).catch(() => undefined);

  const response = await fetch(destination, {
    headers: getProxyRequestHeaders(event),
    method: event.method,
    body,
    redirect: 'follow',
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});