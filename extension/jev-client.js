(() => {
  'use strict';
  const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
  const TIMEOUT_MS = 15000;

  async function evaluate({ text, apiKey, signal, fetchImpl = globalThis.fetch } = {}) {
    const { buildRequest, parseResponse, JevError } = globalThis.NyanJevCore;
    const request = buildRequest(text);
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(apiKey.trim())) throw new JevError('INVALID_KEY');
    const key = apiKey.trim();
    if (typeof fetchImpl !== 'function') throw new JevError('NETWORK');
    let combined;
    try {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    } catch {
      throw new JevError('INVALID_SIGNAL');
    }
    if (combined.aborted) throw new JevError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');

    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(request),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: combined
      });
      if (combined.aborted) throw new JevError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
      if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status) ||
          response.status < 100 || response.status > 599 || typeof response.json !== 'function') {
        throw new JevError('INVALID_RESPONSE', 'HTTP_SHAPE');
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new JevError('AUTH');
        if (response.status === 429) throw new JevError('RATE_LIMIT');
        throw new JevError('API_ERROR');
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new JevError(combined.aborted ? signal?.aborted ? 'CANCELLED' : 'TIMEOUT' : 'INVALID_RESPONSE', 'JSON_DECODE');
      }
      if (combined.aborted) throw new JevError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
      return parseResponse(data);
    } catch (error) {
      if (combined.aborted) throw new JevError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
      if (error instanceof JevError) throw error;
      // Never expose response text, fetch exception text, URL, key, or posted content.
      throw new JevError('NETWORK');
    }
  }

  globalThis.NyanJevClient = Object.freeze({ ENDPOINT, TIMEOUT_MS, evaluate });
})();
