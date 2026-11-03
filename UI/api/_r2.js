// Cloudflare R2 (S3-compatible) for the api/ functions: signed links and the few calls the server makes. Uses the S3 signature
// version 4 query form for everything, so one signing routine serves the browser's links and the server's own requests.
const crypto = require('crypto');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
// RFC 3986 encoding, which S3 signatures require (encodeURIComponent leaves !'()* alone).
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A link that works without further credentials until it expires. `query` adds parameters (such as list-type) to what is signed. */
function presign({ method, host, path, query = {}, region, accessKey, secretKey, expires, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const params = {
    ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': stamp, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort().map((key) => `${encode(key)}=${encode(params[key])}`).join('&');
  const canonicalPath = path.split('/').map(encode).join('/');
  const request = [method, canonicalPath, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(request)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  return {
    bucket: R2_BUCKET, host: `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: 'auto',
    accessKey: R2_ACCESS_KEY_ID, secretKey: R2_SECRET_ACCESS_KEY,
  };
}

/** A signed link for one object of the bucket. */
function link(method, key, expires = 3600, query = {}) {
  const c = r2();
  return presign({ method, host: c.host, path: `/${c.bucket}${key === null ? '' : `/${key}`}`, query, region: c.region, accessKey: c.accessKey, secretKey: c.secretKey, expires });
}

async function r2Call(method, key, query) {
  try {
    return await fetch(link(method, key, 300, query), { method, signal: AbortSignal.timeout(8000) });
  } catch {
    const error = new Error('Cloud storage didn’t respond. Please try again.');
    error.status = 502;
    throw error;
  }
}

/** The account's stored videos: { key, bytes, at } for everything under `prefix`. */
async function listObjects(prefix) {
  const objects = [];
  let token = null;
  for (let page = 0; page < 20; page++) {
    const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
    const response = await r2Call('GET', null, query);
    const xml = await response.text();
    if (!response.ok) throw Object.assign(new Error(`Cloud storage returned ${response.status}.`), { status: 502 });
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const pick = (tag) => item.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '';
      objects.push({ key: pick('Key'), bytes: Number(pick('Size')), at: pick('LastModified') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]*)</)?.[1] : null;
    if (!token) break;
  }
  return objects;
}

/** The object's size, or null when it doesn't exist. */
async function headObject(key) {
  const response = await r2Call('HEAD', key);
  if (response.status === 404) return null;
  if (!response.ok) throw Object.assign(new Error(`Cloud storage returned ${response.status}.`), { status: 502 });
  return Number(response.headers.get('content-length'));
}

async function deleteObject(key) {
  const response = await r2Call('DELETE', key);
  if (!response.ok && response.status !== 404) throw Object.assign(new Error(`Cloud storage returned ${response.status}.`), { status: 502 });
}

module.exports = { presign, link, listObjects, headObject, deleteObject };
