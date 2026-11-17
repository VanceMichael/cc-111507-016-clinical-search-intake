import { createHash } from 'node:crypto';
import { requestBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';

// FHIR searchset 采集。只承诺 docs/来源格式.md 列出的范围：
// - 初页 /fhir?page=1，后续严格跟随 Bundle.link[next]，只访问来源本源内链接；
// - entry.search.mode 为 match/include/outcome，缺 mode 或未知 mode 标为 unknown；
// - 资源身份为 resourceType/id/meta.versionId，fullUrl 仅作为本 Bundle 的引用别名；
// - _history 指定版本必须精确命中，未指定版本不自动替换成任意历史资源；
// - OperationOutcome、局部读取失败和来源告警写入 issues，不能因此宣称完整。
const MAX_PAGES = 50;
const PAGE_BYTES = 16777216;
const SEARCH_PATH = '/fhir';

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tryJson(bytes) {
  try { return JSON.parse(bytes.toString()); } catch { return null; }
}

function searchQuery(input) {
  const raw = input.query ?? input.filter ?? null;
  if (raw == null) return [];
  const pairs = [];
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^\?/, '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('//')) throw new Error('查询参数不能包含来源地址');
    for (const [key, value] of new URLSearchParams(text)) pairs.push([key, value]);
    return pairs;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === 'object') throw new Error('查询参数格式无效');
        pairs.push([key, String(item)]);
      }
    }
    return pairs;
  }
  throw new Error('查询参数格式无效');
}

function buildInitialUrl(input, sourceBase) {
  const url = new URL(SEARCH_PATH, sourceBase);
  const requestedPage = [];
  for (const [key, value] of searchQuery(input)) {
    if (key === 'page') { requestedPage.push(value); continue; }
    url.searchParams.append(key, value);
  }
  // 初页固定为 page=1；后续页只能来自 Bundle.link[next] 携带的来源查询上下文。
  url.searchParams.set('page', '1');
  return { url: url.href, requestedPageIgnored: requestedPage.length > 0 };
}

function identityOf(resource) {
  const resourceType = typeof resource?.resourceType === 'string' && resource.resourceType
    ? resource.resourceType : null;
  const id = typeof resource?.id === 'string' && resource.id ? resource.id : null;
  const versionId = typeof resource?.meta?.versionId === 'string' && resource.meta.versionId
    ? resource.meta.versionId : null;
  if (!resourceType || !id) return { resourceType, id, versionId, identity: null, objectIdentity: null };
  return {
    resourceType,
    id,
    versionId,
    identity: versionId ? `${resourceType}/${id}/_history/${versionId}` : `${resourceType}/${id}`,
    objectIdentity: `${resourceType}/${id}`,
  };
}

function decodePart(part) {
  try { return decodeURIComponent(part); } catch { return part; }
}

function splitReferencePath(raw) {
  let value = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//')) {
    let url;
    try { url = new URL(value); } catch { return { invalid: true }; }
    value = `${url.pathname}${url.search}`;
  }
  value = value.split('#')[0].split('?')[0];
  if (!value) return null;
  const parts = value.split('/').filter(Boolean).map(decodePart);
  const history = parts.lastIndexOf('_history');
  if (history !== -1) {
    // _history 出现但不完整时判为无效，不能退化成未版本化引用。
    if (history < 2 || history + 1 >= parts.length) return { invalid: true };
    return {
      type: parts[history - 2],
      id: parts[history - 1],
      versionId: parts[history + 1],
      versioned: true,
    };
  }
  if (parts.length >= 2) return { type: parts.at(-2), id: parts.at(-1), versioned: false };
  return null;
}

function parseReference(raw, sourceOrigin) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { raw: String(raw ?? ''), kind: 'invalid', reason: '引用为空' };
  if (value.startsWith('#')) {
    return { raw: value, kind: 'contained', reason: '未解析 contained 引用' };
  }
  if (/^urn:/i.test(value)) return { raw: value, kind: 'alias', alias: value };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//')) {
    let url;
    try { url = new URL(value); } catch { return { raw: value, kind: 'invalid', reason: '引用地址无效' }; }
    if (url.origin !== sourceOrigin) {
      return { raw: value, kind: 'external', reason: '引用指向来源之外，未访问' };
    }
  }
  const parts = splitReferencePath(value);
  if (!parts || parts.invalid || !parts.type || !parts.id) {
    return { raw: value, kind: 'invalid', reason: '引用无法解析' };
  }
  return {
    raw: value,
    kind: 'local',
    type: parts.type,
    id: parts.id,
    versionId: parts.versioned ? parts.versionId : null,
    versioned: Boolean(parts.versioned),
    identity: parts.versioned ? `${parts.type}/${parts.id}/_history/${parts.versionId}` : null,
    objectIdentity: `${parts.type}/${parts.id}`,
  };
}

function collectReferences(resource) {
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((value, index) => walk(value, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.reference === 'string') found.push({ reference: node.reference, path: `${path}.reference` });
    for (const [key, value] of Object.entries(node)) {
      if (key === 'reference') continue;
      if (value && typeof value === 'object') walk(value, `${path}.${key}`);
    }
  };
  walk(resource, 'resource');
  const seen = new Set();
  return found.filter(item => {
    const key = `${item.path}\u0000${item.reference}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectExtensions(node, path, output) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectExtensions(value, `${path}[${index}]`, output));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'extension' && Array.isArray(value) && value.length > 0) {
      output.push({ path: `${path}.${key}`, count: value.length });
      continue;
    }
    if (value && typeof value === 'object') collectExtensions(value, `${path}.${key}`, output);
  }
}

function issueFromOutcome(item, context) {
  const source = item && typeof item === 'object' ? item : {};
  const sourceSeverity = typeof source.severity === 'string' ? source.severity : null;
  const severity = sourceSeverity === 'fatal' || sourceSeverity === 'error'
    ? 'error' : sourceSeverity === 'information' ? 'information' : 'warning';
  return {
    severity,
    code: 'source-outcome',
    sourceSeverity,
    sourceCode: typeof source.code === 'string' ? source.code : null,
    diagnostics: source.diagnostics || source.details?.text || '来源返回 OperationOutcome',
    expression: Array.isArray(source.expression) ? source.expression : undefined,
    page: context.page,
    url: context.url,
    path: context.path,
    outcome: source,
  };
}

function nextLinkOf(bundle, currentUrl, sourceOrigin, issues, page) {
  const links = Array.isArray(bundle.link) ? bundle.link : [];
  const candidates = links.filter(link => link && link.relation === 'next'
    && typeof link.url === 'string' && link.url);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    issues.push({
      severity: 'warning', code: 'multiple-next-links',
      diagnostics: '来源在同一页提供了多个 next 链接，仅跟随第一个',
      page: page.number, url: page.url,
    });
  }
  let next;
  try { next = new URL(candidates[0].url, currentUrl); } catch {
    issues.push({
      severity: 'error', code: 'unsafe-next-link',
      diagnostics: '来源提供的 next 链接无法解析，未继续分页',
      page: page.number, url: page.url,
    });
    return { unsafe: true };
  }
  if (!['http:', 'https:'].includes(next.protocol) || next.origin !== sourceOrigin) {
    issues.push({
      severity: 'error', code: 'unsafe-next-link',
      diagnostics: '来源提供的 next 链接指向来源之外，未访问',
      page: page.number, url: page.url, link: candidates[0].url,
    });
    return { unsafe: true };
  }
  return { pending: next.href };
}

export async function collectSearch({ input, descriptor, sourceBase, store }) {
  const sourceOrigin = new URL(sourceBase).origin;
  const { url: initialUrl, requestedPageIgnored } = buildInitialUrl(input, sourceBase);
  const issues = [];
  const pages = [];
  const blobs = new Map();
  const seenUrls = new Set();
  const seenDigests = new Set();
  const entries = [];
  const aliases = new Map();
  const outcomes = [];
  let firstUsable = false;
  let firstBundle = null;
  let firstBytes = null;
  let declaredTotal = null;
  let totalChanged = false;
  let pendingNext = null;
  let loopDetected = false;
  let duplicatePage = null;
  let limitReached = false;
  let failedPage = null;
  let unsafeNext = false;

  let currentUrl = initialUrl;
  while (currentUrl) {
    if (seenUrls.has(currentUrl)) {
      loopDetected = true;
      issues.push({
        severity: 'error', code: 'looping-next',
        diagnostics: '来源的 next 链接回到已读取的页，停止分页',
        page: pages.length, url: currentUrl,
      });
      pendingNext = currentUrl;
      break;
    }
    if (pages.length >= MAX_PAGES) {
      limitReached = true;
      issues.push({
        severity: 'error', code: 'page-limit',
        diagnostics: `来源分页超过 ${MAX_PAGES} 页上限，未继续读取`,
        page: pages.length, url: currentUrl,
      });
      pendingNext = currentUrl;
      break;
    }
    seenUrls.add(currentUrl);

    let result;
    try {
      result = await requestBytes(currentUrl, { limit: PAGE_BYTES });
    } catch (error) {
      failedPage = { url: currentUrl, status: null };
      issues.push({
        severity: 'error', code: 'page-read-failed',
        diagnostics: `读取来源分页失败：${error.message}`,
        page: pages.length + 1, url: currentUrl,
      });
      break;
    }

    const blob = await store.blob(result.bytes);
    if (!blobs.has(blob.digest)) blobs.set(blob.digest, blob);
    const page = {
      number: pages.length + 1,
      url: currentUrl,
      status: result.status,
      etag: result.etag,
      digest: result.digest,
      blob: blob.digest,
      bytes: result.bytes.length,
      entryCount: 0,
      modes: { match: 0, include: 0, outcome: 0, unknown: 0, invalid: 0 },
      next: null,
    };
    pages.push(page);

    if (!result.ok) {
      failedPage = { url: currentUrl, status: result.status };
      const outcome = tryJson(result.bytes);
      if (outcome?.resourceType === 'OperationOutcome') {
        const list = Array.isArray(outcome.issue) && outcome.issue.length > 0 ? outcome.issue : [{}];
        for (const item of list) issues.push(issueFromOutcome(item, { page: page.number, url: currentUrl, path: 'body' }));
      } else {
        issues.push({
          severity: 'error', code: 'page-read-failed',
          diagnostics: `来源返回 ${result.status}，未能取得分页`,
          status: result.status, page: page.number, url: currentUrl,
          bodyDigest: result.digest,
        });
      }
      break;
    }

    if (seenDigests.has(result.digest)) {
      duplicatePage = { url: currentUrl, status: result.status, digest: result.digest, page: page.number };
      issues.push({
        severity: 'error', code: 'duplicate-page',
        diagnostics: '来源返回了已读取过的相同分页内容，重复页不计入结果，也不视作完整',
        page: page.number, url: currentUrl, digest: result.digest,
      });
      break;
    }
    seenDigests.add(result.digest);

    const bundle = tryJson(result.bytes);
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      issues.push({
        severity: 'error', code: 'invalid-bundle',
        diagnostics: '来源分页不是有效 JSON 对象，未继续',
        page: page.number, url: currentUrl, bodyDigest: result.digest,
      });
      break;
    }
    if (bundle.resourceType !== 'Bundle') {
      issues.push({
        severity: 'error', code: 'invalid-bundle',
        diagnostics: `来源分页不是 Bundle（resourceType=${String(bundle.resourceType)}），未继续`,
        page: page.number, url: currentUrl,
      });
      break;
    }
    if (bundle.type !== 'searchset') {
      issues.push({
        severity: 'error', code: 'unsupported-bundle-type',
        diagnostics: `来源 Bundle.type=${String(bundle.type)}，本服务只支持 searchset`,
        page: page.number, url: currentUrl,
      });
      break;
    }
    if (page.number === 1) {
      firstUsable = true;
      firstBundle = bundle;
      firstBytes = result.bytes;
    }

    if (bundle.extension !== undefined) {
      issues.push({
        severity: 'warning', code: 'unsupported-extension',
        diagnostics: 'Bundle 含未约定扩展，原文已保存，本服务未解释该扩展',
        page: page.number, url: currentUrl, path: 'Bundle.extension',
      });
    }

    if (Number.isInteger(bundle.total)) {
      if (declaredTotal == null) declaredTotal = bundle.total;
      else if (declaredTotal !== bundle.total) totalChanged = true;
    }

    if (bundle.entry !== undefined && !Array.isArray(bundle.entry)) {
      issues.push({
        severity: 'error', code: 'invalid-entry-list',
        diagnostics: 'Bundle.entry 不是数组，未解析该页条目',
        page: page.number, url: currentUrl,
      });
    }
    const list = Array.isArray(bundle.entry) ? bundle.entry : [];
    page.entryCount = list.length;

    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      const path = `entry[${index}]`;
      if (!entry || typeof entry !== 'object') {
        page.modes.invalid += 1;
        issues.push({
          severity: 'error', code: 'invalid-entry',
          diagnostics: 'Bundle 条目不是对象，已跳过',
          page: page.number, url: currentUrl, path,
        });
        continue;
      }
      const resource = entry.resource && typeof entry.resource === 'object' ? entry.resource : null;
      const mode = typeof entry.search?.mode === 'string' ? entry.search.mode : null;

      if (mode === 'outcome' || resource?.resourceType === 'OperationOutcome') {
        page.modes.outcome += 1;
        outcomes.push({ page: page.number, url: currentUrl, path, fullUrl: entry.fullUrl ?? null });
        const listIssues = Array.isArray(resource?.issue) ? resource.issue : null;
        if (listIssues && listIssues.length > 0) {
          for (const item of listIssues) issues.push(issueFromOutcome(item, { page: page.number, url: currentUrl, path }));
        } else {
          issues.push({
            severity: 'warning', code: 'source-outcome',
            diagnostics: '来源返回 outcome 条目，未提供可读 issue',
            page: page.number, url: currentUrl, path,
          });
        }
        continue;
      }

      if (mode === null) {
        page.modes.unknown += 1;
        issues.push({
          severity: 'warning', code: 'unknown-search-mode',
          diagnostics: '条目缺少 entry.search.mode，标为 unknown，不计入匹配资源或附带资源',
          page: page.number, url: currentUrl, path,
          identity: resource ? identityOf(resource).identity : null,
        });
        continue;
      }
      if (mode !== 'match' && mode !== 'include') {
        page.modes.unknown += 1;
        issues.push({
          severity: 'warning', code: 'unknown-search-mode',
          diagnostics: `条目 search.mode=${mode} 不在 match/include/outcome 范围内，标为 unknown，不计入结果`,
          page: page.number, url: currentUrl, path, mode,
          identity: resource ? identityOf(resource).identity : null,
        });
        continue;
      }
      if (!resource) {
        page.modes.invalid += 1;
        issues.push({
          severity: 'error', code: 'missing-resource',
          diagnostics: `条目 search.mode=${mode} 但缺少 resource，无法形成记录`,
          page: page.number, url: currentUrl, path,
        });
        continue;
      }
      if (entry.extension !== undefined) {
        issues.push({
          severity: 'warning', code: 'unsupported-extension',
          diagnostics: '条目含未约定扩展，原文已保存，本服务未解释该扩展',
          page: page.number, url: currentUrl, path: `${path}.extension`,
        });
      }
      if (entry.search?.extension !== undefined) {
        issues.push({
          severity: 'warning', code: 'unsupported-extension',
          diagnostics: 'entry.search 含未约定扩展，原文已保存，本服务未解释该扩展',
          page: page.number, url: currentUrl, path: `${path}.search.extension`,
        });
      }
      const unsupportedExtensions = [];
      collectExtensions(resource, 'resource', unsupportedExtensions);
      for (const item of unsupportedExtensions) {
        issues.push({
          severity: 'warning', code: 'unsupported-extension',
          diagnostics: `资源含未约定扩展 ${item.path}，原文已保存，本服务未解释该扩展`,
          page: page.number, url: currentUrl, path: `${path}.${item.path}`,
        });
      }

      const identity = identityOf(resource);
      if (!identity.identity) {
        page.modes.invalid += 1;
        issues.push({
          severity: 'error', code: 'missing-resource-identity',
          diagnostics: '资源缺少 resourceType/id，无法建立稳定身份，已跳过',
          page: page.number, url: currentUrl, path,
        });
        continue;
      }
      if (typeof entry.fullUrl === 'string' && entry.fullUrl) {
        if (!aliases.has(entry.fullUrl)) aliases.set(entry.fullUrl, []);
        aliases.get(entry.fullUrl).push({ identity: identity.identity, page: page.number });
      }
      page.modes[mode] += 1;
      entries.push({
        mode,
        identity: identity.identity,
        objectIdentity: identity.objectIdentity,
        resourceType: identity.resourceType,
        id: identity.id,
        versionId: identity.versionId,
        resource,
        pageBlob: blob.digest,
        resourceDigest: digestOf(resource),
        page: page.number,
        url: currentUrl,
        path,
        fullUrl: typeof entry.fullUrl === 'string' ? entry.fullUrl : null,
      });
    }

    const next = nextLinkOf(bundle, currentUrl, sourceOrigin, issues, page);
    if (next?.unsafe) {
      unsafeNext = true;
      page.next = null;
      break;
    }
    page.next = next?.pending || null;
    if (!page.next) break;
    if (seenUrls.has(page.next)) {
      loopDetected = true;
      issues.push({
        severity: 'error', code: 'looping-next',
        diagnostics: '来源的 next 链接落回已读取的页，停止分页',
        page: page.number, url: page.next,
      });
      pendingNext = page.next;
      break;
    }
    currentUrl = page.next;
  }

  // 按资源身份（类型/id/版本）汇总：跨页同身份只保留一条记录，
  // 同一身份既出现 match 又出现 include 时按 match 计，附带条目单独计数。
  const identities = new Map();
  for (const entry of entries) {
    if (!identities.has(entry.identity)) {
      identities.set(entry.identity, {
        identity: entry.identity,
        objectIdentity: entry.objectIdentity,
        resourceType: entry.resourceType,
        id: entry.id,
        versionId: entry.versionId,
        resource: entry.resource,
        resourceDigest: entry.resourceDigest,
        occurrences: [],
      });
    }
    const aggregate = identities.get(entry.identity);
    aggregate.occurrences.push(entry);
    if (aggregate.resourceDigest !== entry.resourceDigest) {
      issues.push({
        severity: 'error', code: 'identity-content-conflict',
        diagnostics: `同一资源身份 ${entry.identity} 出现了不同内容，保留首次读取的版本`,
        page: entry.page, url: entry.url, path: entry.path,
      });
    }
  }

  const resources = new Map();
  const resourceBodies = new Map();
  let duplicateMatchEntries = 0;
  let duplicateIncludeEntries = 0;
  let includeEntriesForMatchedResources = 0;
  for (const aggregate of identities.values()) {
    const matches = aggregate.occurrences.filter(item => item.mode === 'match');
    const includes = aggregate.occurrences.filter(item => item.mode === 'include');
    const mode = matches.length > 0 ? 'match' : 'include';
    if (mode === 'match') {
      duplicateMatchEntries += Math.max(0, matches.length - 1);
      includeEntriesForMatchedResources += includes.length;
    } else {
      duplicateIncludeEntries += Math.max(0, includes.length - 1);
    }
    const first = aggregate.occurrences[0];
    resources.set(aggregate.identity, {
      mode,
      resourceType: aggregate.resourceType,
      id: aggregate.id,
      versionId: aggregate.versionId,
      identity: aggregate.identity,
      objectIdentity: aggregate.objectIdentity,
      resource: aggregate.resource,
      source: {
        page: first.page, url: first.url, fullUrl: first.fullUrl, path: first.path, blob: first.pageBlob,
      },
      alsoSeenOn: aggregate.occurrences.slice(1).map(item => ({
        page: item.page, url: item.url, fullUrl: item.fullUrl, mode: item.mode,
      })),
      basis: [{
        type: 'search-mode', value: mode, page: first.page, url: first.url, fullUrl: first.fullUrl,
      }],
      references: [],
    });
    resourceBodies.set(aggregate.identity, aggregate.resource);
  }

  const objectIndex = new Map();
  for (const identity of resources.keys()) {
    const parsed = splitReferencePath(identity);
    if (!parsed || parsed.invalid) continue;
    const objectIdentity = `${parsed.type}/${parsed.id}`;
    if (!objectIndex.has(objectIdentity)) objectIndex.set(objectIdentity, new Set());
    objectIndex.get(objectIdentity).add(identity);
  }

  const records = [...resources.values()];
  const relationships = [];
  const versioning = {
    versionedReferences: 0, unversionedReferences: 0, aliasReferences: 0,
    resolved: 0, unresolved: 0, external: 0, ambiguous: 0,
  };

  const addReferenceIssue = (record, relationship, code, diagnostics) => {
    versioning.unresolved += 1;
    issues.push({
      severity: 'warning', code, diagnostics,
      page: record.source.page, url: record.source.url, path: relationship.path,
      identity: record.identity, reference: relationship.reference,
    });
  };

  for (const record of records) {
    for (const found of collectReferences(resourceBodies.get(record.identity))) {
      const parsed = parseReference(found.reference, sourceOrigin);
      const relationship = {
        from: record.identity,
        fromMode: record.mode,
        fromPage: record.source.page,
        path: found.path,
        reference: found.reference,
        kind: parsed.kind,
        versioned: Boolean(parsed.versioned),
        versionId: parsed.versioned ? parsed.versionId : null,
        resolved: false,
        resolvedIdentity: null,
        resolution: null,
        reason: parsed.reason || null,
      };

      if (parsed.kind === 'external') {
        versioning.external += 1;
        relationship.resolution = 'external';
        addReferenceIssue(record, relationship, 'external-reference',
          `引用 ${found.reference} 指向来源之外，未访问，关系未解析`);
      } else if (parsed.kind === 'contained') {
        relationship.resolution = 'contained';
        addReferenceIssue(record, relationship, 'unsupported-reference',
          `引用 ${found.reference} 为 contained 引用，本服务未解析`);
      } else if (parsed.kind === 'invalid') {
        relationship.resolution = 'invalid';
        addReferenceIssue(record, relationship, 'unsupported-reference',
          `引用 ${found.reference} 无法解析：${parsed.reason}`);
      } else if (parsed.kind === 'alias') {
        versioning.aliasReferences += 1;
        const seen = aliases.get(parsed.alias) || [];
        const targets = [...new Set(seen.map(item => item.identity))];
        if (targets.length === 0) {
          relationship.resolution = 'missing';
          relationship.reason = 'fullUrl 别名未出现在已采集条目中';
          addReferenceIssue(record, relationship, 'unresolved-reference',
            `引用 ${found.reference} 的 fullUrl 别名未出现在已采集资源中`);
        } else if (targets.length > 1) {
          versioning.ambiguous += 1;
          relationship.resolution = 'ambiguous';
          relationship.reason = 'fullUrl 别名对应多个资源身份';
          addReferenceIssue(record, relationship, 'ambiguous-reference',
            `引用 ${found.reference} 的 fullUrl 别名对应多个资源身份，未任意选择`);
        } else {
          const target = targets[0];
          relationship.resolved = true;
          relationship.resolvedIdentity = target;
          relationship.resolution = 'full-url-alias';
          versioning.resolved += 1;
          if (resources.has(target)) {
            resources.get(target).basis.push({
              type: 'reference', reference: found.reference, from: record.identity,
              fromMode: record.mode, versioned: false, resolution: 'full-url-alias',
              resolvedIdentity: target,
            });
          }
        }
      } else if (parsed.versioned) {
        versioning.versionedReferences += 1;
        if (resources.has(parsed.identity)) {
          relationship.resolved = true;
          relationship.resolvedIdentity = parsed.identity;
          relationship.resolution = 'exact-version';
          versioning.resolved += 1;
          resources.get(parsed.identity).basis.push({
            type: 'reference', reference: found.reference, from: record.identity,
            fromMode: record.mode, versioned: true, resolution: 'exact-version',
            resolvedIdentity: parsed.identity,
          });
        } else {
          const candidates = objectIndex.get(parsed.objectIdentity) || new Set();
          relationship.resolution = candidates.size > 0 ? 'version-not-present' : 'missing';
          relationship.reason = candidates.size > 0
            ? `已采集 ${[...candidates].join(', ')}，但没有引用指定的版本 ${parsed.versionId}`
            : '已采集资源中没有该类型/id';
          addReferenceIssue(record, relationship, 'unresolved-reference',
            `版本化引用 ${found.reference} 未能精确解析：${relationship.reason}`);
        }
      } else {
        versioning.unversionedReferences += 1;
        const candidates = [...(objectIndex.get(parsed.objectIdentity) || new Set())];
        if (candidates.length === 0) {
          relationship.resolution = 'missing';
          relationship.reason = '已采集资源中没有该类型/id';
          addReferenceIssue(record, relationship, 'unresolved-reference',
            `未指定版本的引用 ${found.reference} 未能解析：已采集资源中没有该类型/id`);
        } else if (candidates.length === 1) {
          // 只采集到一个候选时可解析，但记录来源未指定版本，解析版本仅为已采集版本。
          const target = candidates[0];
          relationship.resolved = true;
          relationship.resolvedIdentity = target;
          relationship.resolvedVersionId = splitReferencePath(target)?.versionId ?? null;
          relationship.resolution = 'unversioned-single-candidate';
          versioning.resolved += 1;
          resources.get(target).basis.push({
            type: 'reference', reference: found.reference, from: record.identity,
            fromMode: record.mode, versioned: false, resolution: 'unversioned-single-candidate',
            resolvedIdentity: target,
          });
        } else {
          relationship.resolution = 'ambiguous';
          relationship.reason = `已采集多个身份（${candidates.join(', ')}），来源未指定版本，不任意替换成某个历史资源`;
          versioning.ambiguous += 1;
          addReferenceIssue(record, relationship, 'ambiguous-unversioned-reference',
            `未指定版本的引用 ${found.reference} 对应多个已采集身份，未任意选择`);
        }
      }
      record.references.push(relationship);
      relationships.push(relationship);
    }
  }

  const matchResources = records.filter(record => record.mode === 'match').length;
  const includeResources = records.filter(record => record.mode === 'include').length;
  const matchObjects = new Set(records.filter(record => record.mode === 'match').map(record => record.objectIdentity)).size;
  const includeObjects = new Set(records.filter(record => record.mode === 'include').map(record => record.objectIdentity)).size;
  const totalEntries = pages.reduce((sum, page) => sum + page.entryCount, 0);
  const counts = {
    entriesOnPages: totalEntries,
    matchEntries: pages.reduce((sum, page) => sum + page.modes.match, 0),
    includeEntries: pages.reduce((sum, page) => sum + page.modes.include, 0),
    outcomeEntries: pages.reduce((sum, page) => sum + page.modes.outcome, 0),
    unknownModeEntries: pages.reduce((sum, page) => sum + page.modes.unknown, 0),
    invalidEntries: pages.reduce((sum, page) => sum + page.modes.invalid, 0),
    matchResources,
    includeResources,
    matchObjects,
    includeObjects,
    duplicateMatchEntries,
    duplicateIncludeEntries,
    includeEntriesForMatchedResources,
  };

  if (totalChanged) {
    issues.push({
      severity: 'warning', code: 'total-inconsistent',
      diagnostics: '来源在不同分页声明的 total 不一致，只将 total 视为来源声明',
      page: pages.length, url: pages.at(-1)?.url,
    });
  }
  if (declaredTotal != null && declaredTotal !== matchResources) {
    issues.push({
      severity: 'warning', code: 'total-mismatch',
      diagnostics: `来源声明 total=${declaredTotal}，已采集唯一匹配资源 ${matchResources}，不能据此宣称筛选范围完整`,
      page: 1, url: initialUrl,
    });
  }
  if (pendingNext && !loopDetected) {
    issues.push({
      severity: 'warning', code: 'incomplete-pagination',
      diagnostics: '来源仍提供下一页，本次未继续读取，筛选范围不完整',
      page: pages.length, url: pendingNext,
    });
  }

  const gaps = issues.map(issue => ({
    code: issue.code,
    detail: issue.diagnostics,
    page: issue.page ?? null,
    url: issue.url ?? null,
  }));
  if (requestedPageIgnored) {
    gaps.push({ code: 'page-parameter-ignored', detail: '请求携带的 page 参数已忽略，初页固定为来源约定的 page=1', page: null, url: initialUrl });
  }

  const complete = firstUsable && issues.length === 0 && gaps.length === 0;
  const state = firstUsable ? (complete ? 'complete' : 'partial') : 'rejected';
  if (!complete && gaps.length === 0) gaps.push({ code: 'unexplained', detail: '存在未解释的来源内容，不能宣称完整', page: null, url: null });

  const coverage = {
    structured: true,
    scope: {
      initialUrl,
      searchPath: SEARCH_PATH,
      sameOriginOnly: true,
      requestedPageIgnored,
      nextFollowed: Math.max(0, pages.length - 1),
    },
    pages: {
      fetched: pages.length,
      urls: pages.map(page => page.url),
      failed: failedPage ? [failedPage] : [],
      duplicate: duplicatePage ? [duplicatePage] : [],
      loopDetected,
      limitReached,
      unsafeNext,
      nextPending: pendingNext,
      exhausted: !pendingNext && !loopDetected && !duplicatePage && !limitReached && !failedPage && !unsafeNext,
    },
    counts,
    total: {
      declared: declaredTotal,
      matchResources,
      consistent: declaredTotal == null ? null : declaredTotal === matchResources,
    },
    relationships: { extracted: relationships.length, ...versioning },
    complete,
    state,
    gaps,
  };

  const sourceVersion = pages.map(page => page.etag).find(etag => etag) || descriptor.version || null;
  const evidence = {
    search: { path: SEARCH_PATH, initialUrl, descriptor: descriptor.id ?? null },
    pages: pages.map(page => ({
      number: page.number,
      url: page.url,
      status: page.status,
      etag: page.etag,
      digest: page.digest,
      blob: page.blob,
      bytes: page.bytes,
      entries: page.entryCount,
      next: page.next,
    })),
    sourceClaims: {
      bundleType: firstBundle?.type ?? null,
      total: declaredTotal,
      links: pages.map(page => ({ page: page.number, next: page.next })),
    },
    outcomes,
    relationships,
    versioning,
  };

  const receipt = await store.save({
    state,
    mode: 'structured',
    product: descriptor.product,
    source: initialUrl,
    sourceVersion,
    metadata: firstBytes
      ? inspect(firstBytes)
      : { format: 'FHIR R4', bundleType: null, entriesOnPage: 0 },
    blobs: [...blobs.values()],
    records,
    issues,
    coverage,
    evidence,
  });
  return { receipt };
}
