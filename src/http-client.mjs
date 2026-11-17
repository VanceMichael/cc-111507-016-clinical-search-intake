import { createHash } from 'node:crypto';

// 读取一次来源响应。非 2xx 也保留状态和正文，调用方需要区分
// “来源明确拒绝/告警”和“网络读取失败”，不能把两者都丢掉。
export async function requestBytes(url, { headers = {}, limit = 16777216, timeout = 5000 } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  const parts = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > limit) throw new Error('来源超出收件限额');
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts);
  return {
    ok: response.ok,
    bytes,
    status: response.status,
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    contentRange: response.headers.get('content-range'),
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function receiveBytes(url, options = {}) {
  const result = await requestBytes(url, options);
  if (!result.ok) throw new Error(`来源返回 ${result.status}`);
  return result;
}
