const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export function normalizeAlias(alias) {
  return String(alias).trim().toLowerCase();
}

export function parseReference(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'empty', resourceType: null, id: null, version: null };
  if (text.startsWith('#')) return { kind: 'contained', id: decodeURIComponent(text.slice(1)), resourceType: null, version: null };
  if (/^urn:/i.test(text)) return { kind: 'alias', alias: text, resourceType: null, id: null, version: null };
  let url;
  try { url = new URL(text, 'http://reference.invalid'); } catch { return { kind: 'other', resourceType: null, id: null, version: null, raw: text }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'other', resourceType: null, id: null, version: null, raw: text };
  const segments = url.pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  const history = segments.lastIndexOf('_history');
  let resourceType = null;
  let id = null;
  let version = null;
  if (history >= 2 && history + 1 < segments.length) {
    resourceType = segments[history - 2];
    id = segments[history - 1];
    version = segments[history + 1];
  } else if (segments.length >= 2) {
    resourceType = segments[segments.length - 2];
    id = segments[segments.length - 1];
  }
  if (!resourceType || !id) return { kind: 'other', resourceType: null, id: null, version: null, raw: text };
  return {
    kind: 'relative', resourceType, id, version,
    absolute: ABSOLUTE.test(text) ? url.origin : null,
    raw: text,
  };
}

export function collectReferenceTexts(resource) {
  const found = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 24) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node.reference === 'string' && node.reference.trim()) found.add(node.reference);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'reference') continue;
      walk(value, depth + 1);
    }
  };
  walk(resource, 0);
  return [...found].sort();
}

function findContained(resource, id) {
  if (!Array.isArray(resource?.contained)) return null;
  return resource.contained.find(item => item && String(item.id) === id) || null;
}

export function resolveRecordReferences(records, { aliases = new Map(), sourceOrigin = null } = {}) {
  const byTypeId = new Map();
  const byIdentity = new Map();
  for (const record of records) {
    byIdentity.set(record.identity, record);
    if (!record.resourceType || !record.id) continue;
    const key = `${record.resourceType}/${record.id}`;
    if (!byTypeId.has(key)) byTypeId.set(key, []);
    byTypeId.get(key).push(record);
  }
  const stats = { total: 0, resolved: 0, unresolved: 0, versioned: 0, unversioned: 0,
    contained: 0, ambiguous: 0, versionMismatch: 0, versionedNotInResultSet: 0, notInResultSet: 0 };
  const issues = [];

  const unresolved = (record, raw, reason, severity, code, diagnostics) => {
    stats.unresolved++;
    if (severity !== 'information') issues.push({ severity, code, diagnostics, source: { recordIdentity: record.identity, reference: raw } });
  };

  for (const record of records) {
    const references = [];
    for (const raw of collectReferenceTexts(record.resource)) {
      stats.total++;
      const parsed = parseReference(raw);
      const result = { reference: raw, kind: parsed.kind, versioned: parsed.kind === 'relative' && parsed.version !== null,
        resolved: false, reason: null, targetIdentity: null, targetMode: null, targetVersion: null };
      if (result.versioned) stats.versioned++;
      if (parsed.kind === 'contained') {
        const contained = findContained(record.resource, parsed.id);
        if (contained) {
          result.resolved = true;
          result.targetIdentity = `${record.identity}#${contained.resourceType || 'Resource'}/${parsed.id}`;
          result.targetMode = record.mode;
          stats.resolved++;
          stats.contained++;
        } else {
          result.reason = 'contained-not-found';
          unresolved(record, raw, result.reason, 'information', 'contained-reference-missing', `引用 ${raw} 在资源内未找到`);
        }
      } else if (parsed.kind === 'alias') {
        const identities = aliases.get(normalizeAlias(raw));
        const targets = identities ? [...identities].map(identity => byIdentity.get(identity)).filter(Boolean) : [];
        if (targets.length === 1) {
          result.resolved = true;
          result.targetIdentity = targets[0].identity;
          result.targetMode = targets[0].mode;
          result.targetVersion = targets[0].version;
          stats.resolved++;
        } else if (targets.length > 1) {
          result.reason = 'ambiguous-alias';
          stats.ambiguous++;
          unresolved(record, raw, result.reason, 'warning', 'ambiguous-reference-alias',
            `引用别名 ${raw} 在不同页面指向多个资源，未自动选取`);
        } else {
          result.reason = 'unknown-alias';
          unresolved(record, raw, result.reason, 'information', 'reference-not-in-result-set', `引用别名 ${raw} 未在本结果集中出现`);
        }
      } else if (parsed.kind === 'relative') {
        if (parsed.absolute && sourceOrigin && parsed.absolute !== sourceOrigin) {
          result.reason = 'external-reference';
          unresolved(record, raw, result.reason, 'information', 'reference-outside-source', `引用 ${raw} 指向来源以外地址，未解析`);
        } else {
          const candidates = byTypeId.get(`${parsed.resourceType}/${parsed.id}`) || [];
          if (parsed.version !== null) {
            const exact = candidates.find(candidate => candidate.version === parsed.version);
            if (exact) {
              result.resolved = true;
              result.targetIdentity = exact.identity;
              result.targetMode = exact.mode;
              result.targetVersion = exact.version;
              stats.resolved++;
            } else if (candidates.length) {
              result.reason = 'version-not-present';
              stats.versionMismatch++;
              unresolved(record, raw, result.reason, 'warning', 'reference-version-mismatch',
                `引用 ${raw} 要求版本 ${parsed.version}，结果集中仅有 ${candidates.map(c => c.version ?? '无版本').join('、')}`);
            } else {
              result.reason = 'not-in-result-set';
              stats.versionedNotInResultSet++;
              unresolved(record, raw, result.reason, 'information', 'reference-not-in-result-set', `引用 ${raw} 要求版本 ${parsed.version}，该目标未在本结果集中出现`);
            }
          } else {
            stats.unversioned++;
            if (candidates.length === 1) {
              result.resolved = true;
              result.targetIdentity = candidates[0].identity;
              result.targetMode = candidates[0].mode;
              result.targetVersion = candidates[0].version;
              stats.resolved++;
            } else if (candidates.length > 1) {
              result.reason = 'ambiguous-unversioned';
              stats.ambiguous++;
              unresolved(record, raw, result.reason, 'warning', 'ambiguous-unversioned-reference',
                `引用 ${raw} 未指定版本，结果集中存在多个版本，未自动选取`);
            } else {
              result.reason = 'not-in-result-set';
              stats.notInResultSet++;
              unresolved(record, raw, result.reason, 'information', 'reference-not-in-result-set', `引用 ${raw} 的目标未在本结果集中出现`);
            }
          }
        }
      } else {
        result.reason = 'unsupported-reference';
        unresolved(record, raw, result.reason, 'information', 'reference-unsupported', `引用 ${raw} 形式不受支持，保留原文`);
      }
      references.push(result);
    }
    record.references = references;
  }
  return { stats, issues };
}
