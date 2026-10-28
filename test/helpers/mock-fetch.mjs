// Preloaded with `node --import` by test/snapshot-1.test.ts: every request to api.openalex.org answers
// "429, retry in 1 ms", so the snapshot's OpenAlex requests fail after their retries without any network.
globalThis.fetch = async (url) => {
  if (String(url).includes('api.openalex.org')) return new Response('busy', { status: 429, headers: { 'retry-after': '0.001' } });
  throw new Error(`unexpected request to ${url}`);
};
