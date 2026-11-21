// Fetch a stream header or segment without caching an error response as media.
// Short retries handle transient CDN failures without stalling the live recorder indefinitely.
export async function fetchPiece(url, { fetcher = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 3 } = {}) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Stream download returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error('Stream download was empty');
      return bytes;
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts) await pause(500 * (attempt + 1));
    }
  }
  throw failure ?? new Error('Stream download failed');
}
