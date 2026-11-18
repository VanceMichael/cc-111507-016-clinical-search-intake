import { createHash } from 'node:crypto';
import { receiveResponse } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { normalizeAlias, resolveRecordReferences } from './references.mjs';

const MAX_PAGES = 50;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MATCH = 'match';
const INCLUDE = 'include';
const OUTCOME = 'outcome';
const UNKNOWN = 'unknown';
const SEARCH_PARAMETERS = ['filter', 'version', 'region', 'client', 'tables', 'view', 'basisPath'];

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }

function digestOf(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function resourceIdentity(resource, entry) {
  const resourceType = text(resource?.resourceType);
  const id = text(resource?.id);
  const version = text(resource?.meta?.versionId);
  if (resourceType && id) {
    const identity = `${resourceType}/${id}${version ? `/_history/${version}` : ''}`;
    return { resourceType, id, version, identity, key: `${resourceType}/${id}|${version ?? ''}`, stable: true };
  }
  const fullUrl = text(entry?.fullUrl);
  if (fullUrl) {
    return { resourceType, id, version, identity: `fullUrl:${fullUrl}`, key: `fullUrl:${fullUrl}`, stable: false };
  }
  const digest = digestOf(Buffer.from(JSON.stringify(resource ?? null)));
  return { resourceType, id, version, identity: `sha256:${digest}`, key: `sha256:${digest}`, stable: false };
}

function entryMode(entry) {
  const raw = entry?.search?.mode;
  if (raw === MATCH || raw === INCLUDE || raw === OUTCOME) return { mode: raw, raw };
  if (raw === undefined || raw === null) return { mode: UNKNOWN, raw: null };
  return { mode: UNKNOWN, raw };
}

function parsePage(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString()); }
  catch { return { error: '来源页面不是有效 JSON', code: 'page-invalid-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '来源页面不是 FHIR 资源', code: 'page-not-bundle' };
  }
  const type = value.resourceType === 'Bundle' ? text(value.type) : null;
  if (!type) return { value, error: '来源页面不是 FHIR Bundle', code: 'page-not-bundle' };
  return { value, bundle: value, type };
}

function nextLinks(bundle) {
  if (!Array.isArray(bundle?.link)) return [];
  return bundle.link
    .filter(link => link && link.relation === 'next' && text(link.url))
    .map(link => text(link.url));
}

function describeLink(raw, pageUrl, sourceOrigin) {
  let resolved;
  try { resolved = new URL(raw, pageUrl); } catch { return { url: null, allowed: false, reason: 'next-link-invalid' }; }
  if (!['http:', 'https:'].includes(resolved.protocol) || resolved.origin !== sourceOrigin) {
    return { url: resolved.href, allowed: false, reason: 'next-link-outside-source' };
  }
  resolved.hash = '';
  return { url: resolved.href, allowed: true, reason: null };
}

function issuesFromOutcome(outcome, location) {
  const list = Array.isArray(outcome?.issue) ? outcome.issue : [];
  if (!list.length) {
    return [{ severity: 'warning', code: 'outcome-without-issue', diagnostics: '来源返回 OperationOutcome 但未给出 issue', source: location }];
  }
  return list.map(item => ({
    severity: ['fatal', 'error', 'warning', 'information'].includes(item?.severity) ? item.severity : 'warning',
    code: text(item?.code) || 'outcome-issue',
    diagnostics: text(item?.diagnostics) || null,
    details: item?.details ?? undefined,
    expression: Array.isArray(item?.expression) ? item.expression : undefined,
    source: location,
  }));
}

function addGap(gaps, code, reason) {
  if (!gaps.some(gap => gap.code === code && gap.reason === reason)) gaps.push({ code, reason });
}

function initialSearchUrl(sourceBase, input) {
  const url = new URL('/fhir', sourceBase);
  url.searchParams.set('page', '1');
  if (text(input.query)) {
    const supplied = new URLSearchParams(input.query.replace(/^\?/, ''));
    for (const [key, value] of supplied) {
      if (key === 'page') continue;
      url.searchParams.set(key, value);
    }
  }
  for (const key of SEARCH_PARAMETERS) {
    if (text(input[key]) !== null && !url.searchParams.has(key)) url.searchParams.set(key, input[key]);
  }
  return url;
}

export async function collectStructured({ input = {}, descriptor = {}, sourceBase, store }) {
  const sourceOrigin = new URL(sourceBase).origin;
  const initialUrl = initialSearchUrl(sourceBase, input);
  const request = { mode: 'structured' };
  if (text(input.query)) request.query = input.query;
  for (const key of SEARCH_PARAMETERS) if (text(input[key]) !== null) request[key] = input[key];

  const issues = [];
  const gaps = [];
  const blobs = [];
  const blobDigests = new Set();
  const addBlob = async bytes => {
    const blob = await store.blob(bytes);
    if (blobDigests.has(blob.digest)) return blob;
    blobDigests.add(blob.digest);
    blobs.push(blob);
    return blob;
  };
  const pages = [];
  const records = [];
  const recordByKey = new Map();
  const aliases = new Map();
  const visitedUrls = new Set();
  const visitedDigests = new Map();
  const unknownEntries = [];
  let declaredTotal = null;
  let entriesSeen = 0;
  const entriesByMode = { match: 0, include: 0, outcome: 0, unknown: 0 };
  let duplicateEntries = 0;
  let crossPageDuplicates = 0;
  let outcomeCount = 0;
  let nextFollowed = 0;
  let paginationComplete = false;
  let rejected = false;
  let currentUrl = initialUrl.href;
  let isFirstPage = true;
  let firstPageBytes = null;

  while (currentUrl) {
    const pageNumber = pages.length + 1;
    if (pages.length >= MAX_PAGES) {
      issues.push({ severity: 'warning', code: 'pagination-limit',
        diagnostics: `分页超过 ${MAX_PAGES} 页，停止继续领取`, source: { page: pageNumber, sourceUrl: currentUrl } });
      addGap(gaps, 'pagination-limit', '分页未在页数上限内结束，筛选范围不完整');
      break;
    }
    if (visitedUrls.has(currentUrl)) {
      issues.push({ severity: 'warning', code: 'pagination-loop',
        diagnostics: '来源分页链接回到已领取页面，停止继续领取', source: { page: pageNumber, sourceUrl: currentUrl } });
      addGap(gaps, 'pagination-loop', '分页链接形成循环，筛选范围不完整');
      break;
    }
    visitedUrls.add(currentUrl);

    let response;
    try {
      response = await receiveResponse(currentUrl, { limit: MAX_PAGE_BYTES });
    } catch (error) {
      const partial = error.partial;
      let partialBlob = null;
      if (partial?.bytes?.length) {
        partialBlob = await addBlob(partial.bytes);
        pages.push({ page: pageNumber, url: currentUrl, status: partial.status, etag: partial.etag,
          digest: partial.digest, bytes: partial.bytes.length, entries: 0, accepted: false, partial: true });
      } else {
        pages.push({ page: pageNumber, url: currentUrl, status: null, etag: null,
          digest: null, bytes: 0, entries: 0, accepted: false, partial: false });
      }
      issues.push({ severity: 'warning', code: 'page-read-failed',
        diagnostics: `来源页面读取失败：${error.message}${partialBlob ? '；已保留已读片段' : ''}`,
        source: { page: pageNumber, sourceUrl: currentUrl, digest: partial?.digest ?? null } });
      addGap(gaps, 'page-read-failed', '页面读取中断，筛选范围不完整');
      break;
    }

    if (isFirstPage) firstPageBytes = response.bytes;
    if (response.bytes.length) await addBlob(response.bytes);
    const pageRecord = {
      page: pageNumber, url: currentUrl, status: response.status, etag: response.etag,
      digest: response.digest, bytes: response.bytes.length, entries: 0, accepted: false,
    };
    pages.push(pageRecord);

    if (!response.ok) {
      issues.push({ severity: 'warning', code: 'page-http-error',
        diagnostics: `来源页面返回 ${response.status}`, source: { page: pageNumber, sourceUrl: currentUrl } });
      const parsed = parsePage(response.bytes);
      const outcome = parsed.bundle?.resourceType === 'OperationOutcome' ? parsed.bundle
        : parsed.value?.resourceType === 'OperationOutcome' ? parsed.value : null;
      if (outcome) issues.push(...issuesFromOutcome(outcome, { page: pageNumber, sourceUrl: currentUrl }));
      addGap(gaps, 'page-http-error', `来源页面返回 ${response.status}，筛选范围不完整`);
      break;
    }

    const parsed = parsePage(response.bytes);
    if (parsed.error) {
      issues.push({ severity: 'warning', code: parsed.code, diagnostics: parsed.error,
        source: { page: pageNumber, sourceUrl: currentUrl } });
      if (parsed.value?.resourceType === 'OperationOutcome') {
        issues.push(...issuesFromOutcome(parsed.value, { page: pageNumber, sourceUrl: currentUrl }));
      }
      addGap(gaps, parsed.code, `${parsed.error}，筛选范围不完整`);
      if (isFirstPage) rejected = true;
      break;
    }
    const { bundle } = parsed;
    if (parsed.type !== 'searchset') {
      issues.push({ severity: 'warning', code: 'page-not-searchset',
        diagnostics: `来源 Bundle 类型为 ${parsed.type}，仅支持 searchset`, source: { page: pageNumber, sourceUrl: currentUrl } });
      addGap(gaps, 'page-not-searchset', '来源页面不是 searchset，筛选范围不完整');
      if (isFirstPage) rejected = true;
      break;
    }

    const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
    if (declaredTotal === null && typeof bundle.total === 'number' && Number.isFinite(bundle.total)) declaredTotal = bundle.total;

    const previousPage = visitedDigests.get(response.digest);
    if (previousPage !== undefined) {
      pageRecord.duplicateOf = previousPage;
      issues.push({ severity: 'warning', code: 'duplicate-page',
        diagnostics: `来源页面与第 ${previousPage} 页内容相同，不重复计入`, source: { page: pageNumber, sourceUrl: currentUrl } });
      addGap(gaps, 'duplicate-page', '来源返回重复页面，筛选范围不完整');
      break;
    }
    visitedDigests.set(response.digest, pageNumber);
    pageRecord.accepted = true;
    pageRecord.entries = entries.length;
    entriesSeen += entries.length;

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      const location = { page: pageNumber, sourceUrl: currentUrl, entryIndex };
      if (!entry || typeof entry !== 'object' || !entry.resource || typeof entry.resource !== 'object') {
        issues.push({ severity: 'warning', code: 'entry-without-resource',
          diagnostics: 'Bundle 条目缺少 resource，未计入结果', source: location });
        continue;
      }
      const { mode, raw } = entryMode(entry);
      const resource = entry.resource;
      entriesByMode[mode]++;

      if (mode === OUTCOME) {
        outcomeCount++;
        if (resource.resourceType === 'OperationOutcome') {
          issues.push(...issuesFromOutcome(resource, location));
        } else {
          issues.push({ severity: 'warning', code: 'outcome-entry-not-operationoutcome',
            diagnostics: `标记为 outcome 的条目资源类型为 ${resource.resourceType || '未知'}，保留原文但不计入匹配`, source: location });
        }
        addGap(gaps, 'source-outcome', '来源返回 outcome 条目，结果范围存在未决部分');
        continue;
      }

      if (mode === UNKNOWN) {
        const identity = resourceIdentity(resource, entry);
        unknownEntries.push({ identity: identity.identity, version: identity.version, source: location, basis: raw });
        if (raw !== null) {
          issues.push({ severity: 'warning', code: 'entry-mode-unknown',
            diagnostics: `条目标明的搜索方式 ${JSON.stringify(raw)} 不受支持，未计入匹配，原文保留`, source: location });
        }
        addGap(gaps, 'entry-mode-unknown', '存在未标明或无法识别的搜索方式条目，无法确认是否属于匹配结果');
        continue;
      }

      const identity = resourceIdentity(resource, entry);
      if (!identity.stable) {
        issues.push({ severity: 'information', code: 'entry-unstable-identity',
          diagnostics: '条目缺少 resourceType/id，改用 fullUrl 或内容摘要标识', source: location });
      }
      const fullUrl = text(entry.fullUrl);
      if (fullUrl) {
        const alias = normalizeAlias(fullUrl);
        if (!aliases.has(alias)) aliases.set(alias, new Set());
        aliases.get(alias).add(identity.identity);
      }

      const existing = recordByKey.get(identity.key);
      if (existing) {
        duplicateEntries++;
        if (existing.source.page !== pageNumber) crossPageDuplicates++;
        existing.occurrences += 1;
        existing.locations.push(location);
        if (existing.mode === INCLUDE && mode === MATCH) {
          existing.mode = MATCH;
          existing.basis.mode = MATCH;
          existing.basis.rawMode = raw;
        }
        continue;
      }

      const record = {
        mode,
        identity: identity.identity,
        resourceType: identity.resourceType,
        id: identity.id,
        version: identity.version,
        fullUrl,
        basis: { mode, rawMode: raw, fullUrl, page: pageNumber, entryIndex },
        source: location,
        occurrences: 1,
        locations: [location],
        resource,
        references: [],
      };
      records.push(record);
      recordByKey.set(identity.key, record);
    }

    const links = nextLinks(bundle);
    if (!links.length) {
      paginationComplete = true;
      currentUrl = null;
      break;
    }
    if (links.length > 1) {
      issues.push({ severity: 'warning', code: 'multiple-next-links',
        diagnostics: '来源给出多个 next 链接，仅按第一个继续', source: { page: pageNumber, sourceUrl: currentUrl } });
      addGap(gaps, 'multiple-next-links', '分页链接不唯一，筛选范围无法完全确认');
    }
    const next = describeLink(links[0], currentUrl, sourceOrigin);
    if (!next.allowed) {
      issues.push({ severity: 'warning', code: next.reason,
        diagnostics: next.reason === 'next-link-outside-source'
          ? `分页链接 ${links[0]} 指向来源以外地址，未继续领取`
          : `分页链接 ${links[0]} 无法解析，未继续领取`,
        source: { page: pageNumber, sourceUrl: currentUrl } });
      addGap(gaps, next.reason, '分页未能按来源上下文继续，筛选范围不完整');
      currentUrl = null;
      break;
    }
    nextFollowed++;
    currentUrl = next.url;
    isFirstPage = false;
  }

  const referenceResult = resolveRecordReferences(records, { aliases, sourceOrigin });
  issues.push(...referenceResult.issues);
  for (const issue of referenceResult.issues) {
    if (['warning', 'error', 'fatal'].includes(issue.severity)) {
      addGap(gaps, issue.code, '引用关系未能完全解析，范围存在未决部分');
    }
  }

  const matches = records.filter(record => record.mode === MATCH);
  const includes = records.filter(record => record.mode === INCLUDE);
  if (declaredTotal !== null && declaredTotal !== matches.length) {
    issues.push({ severity: 'information', code: 'source-total-declared-only',
      diagnostics: `来源声明 total=${declaredTotal}，本次取得 ${matches.length} 条匹配记录；total 仅作来源声明，不用于判定完整` });
  }

  const acceptedPages = pages.filter(page => page.accepted).length;
  if (!acceptedPages) rejected = true;
  const complete = paginationComplete && gaps.length === 0 && !rejected;
  const state = rejected ? 'rejected' : complete ? 'complete' : 'partial';
  const coverage = {
    structured: true,
    complete,
    state,
    gaps,
    request,
    pagination: {
      initialUrl: initialUrl.href,
      pagesVisited: pages.length,
      nextFollowed,
      completed: paginationComplete,
      pageUrls: pages.map(page => page.url),
      visitedUrls: [...visitedUrls],
    },
    counts: {
      entriesSeen,
      entriesByMode,
      match: matches.length,
      include: includes.length,
      outcome: outcomeCount,
      unknown: unknownEntries.length,
      uniqueResources: records.length,
      duplicateEntries,
      crossPageDuplicates,
    },
    total: { value: declaredTotal, basis: 'source-declared-only' },
    references: referenceResult.stats,
    unknownEntries,
    downloadedBytes: pages.reduce((sum, page) => sum + page.bytes, 0),
  };

  const receipt = {
    state,
    mode: 'structured',
    product: descriptor.product ?? null,
    source: text(input.query) ? `fhir-searchset?${input.query.replace(/^\?/, '')}` : 'fhir-searchset',
    sourceVersion: pages[0]?.etag ?? null,
    metadata: firstPageBytes ? inspect(firstPageBytes) : { format: 'FHIR R4', bundleType: null, entriesOnPage: 0 },
    blobs,
    records,
    issues,
    evidence: {
      pages: pages.map(page => ({ page: page.page, url: page.url, status: page.status, etag: page.etag,
        digest: page.digest, bytes: page.bytes, entries: page.entries, accepted: page.accepted,
        ...(page.duplicateOf ? { duplicateOf: page.duplicateOf } : {}),
        ...(page.partial ? { partial: true } : {}) })),
      references: referenceResult.stats,
      matchingBasis: 'entry.search.mode',
      matchIdentities: matches.map(record => record.identity),
      includedIdentities: includes.map(record => record.identity),
    },
    coverage,
  };
  return { receipt };
}
