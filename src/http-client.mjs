import { createHash } from 'node:crypto';

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function describe(error) {
  return error?.cause?.message ? `${error.message}（${error.cause.message}）` : error?.message || String(error);
}

export async function receiveResponse(url, { headers = {}, limit = 16777216 } = {}) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
  } catch (error) {
    throw new Error(`来源无法访问：${describe(error)}`, { cause: error });
  }
  const parts = [];
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > limit) throw new Error('来源超出收件限额');
      parts.push(chunk);
    }
  } catch (error) {
    const bytes = Buffer.concat(parts);
    const partial = new Error(`来源正文读取中断：${describe(error)}`, { cause: error });
    partial.partial = { ok: response.ok, status: response.status, etag: response.headers.get('etag'),
      contentRange: response.headers.get('content-range'), bytes, digest: digest(bytes) };
    throw partial;
  }
  const bytes = Buffer.concat(parts);
  return { ok: response.ok, status: response.status, etag: response.headers.get('etag'),
    contentRange: response.headers.get('content-range'), bytes, digest: digest(bytes) };
}

export async function receiveBytes(url, options = {}) {
  const response = await receiveResponse(url, options);
  if (!response.ok) throw new Error(`来源返回 ${response.status}`);
  return response;
}
