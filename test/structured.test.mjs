import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

async function intake(service, input = { mode: 'structured' }) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return { status: response.status, receipt: await response.json() };
}

function withService(scenario, run) {
  return async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
    const service = await createService({ dataDir, scenario });
    try { await run(service, dataDir); }
    finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
  };
}

test('结构化收件：区分命中与附带资源，按版本去重跨页附带资源', withService('standard', async service => {
  const { status, receipt } = await intake(service);
  assert.equal(status, 201);
  assert.ok(['complete', 'partial'].includes(receipt.state));
  assert.equal(receipt.state, 'partial');
  assert.ok(Array.isArray(receipt.records));
  assert.ok(Array.isArray(receipt.issues));

  const matches = receipt.records.filter(record => record.mode === 'match');
  const includes = receipt.records.filter(record => record.mode === 'include');
  assert.deepEqual(matches.map(record => record.identity).sort(), ['Patient/p1/_history/2', 'Patient/p2/_history/1']);
  assert.deepEqual(includes.map(record => record.identity), ['Organization/o1/_history/1']);
  assert.equal(receipt.records.length, 3);
  assert.equal(receipt.coverage.counts.entriesSeen, 5);
  assert.equal(receipt.coverage.counts.match, 2);
  assert.equal(receipt.coverage.counts.include, 1);
  assert.equal(receipt.coverage.counts.outcome, 1);
  assert.equal(receipt.coverage.counts.duplicateEntries, 1);
  assert.equal(receipt.coverage.counts.crossPageDuplicates, 1);

  const organization = includes[0];
  assert.equal(organization.occurrences, 2);
  assert.deepEqual(organization.locations.map(item => item.page), [1, 2]);
  assert.equal(organization.basis.mode, 'include');
  assert.ok(matches.every(record => record.basis.mode === 'match'));

  const reference = matches.find(record => record.identity.startsWith('Patient/p1')).references[0];
  assert.equal(reference.reference, 'Organization/o1/_history/1');
  assert.equal(reference.versioned, true);
  assert.equal(reference.resolved, true);
  assert.equal(reference.targetIdentity, 'Organization/o1/_history/1');
  assert.equal(reference.targetMode, 'include');
  assert.equal(receipt.coverage.references.versioned, 1);
  assert.equal(receipt.coverage.references.resolved, 1);

  assert.ok(receipt.issues.some(issue => issue.code === 'incomplete' && issue.source.page === 2));
  assert.ok(receipt.coverage.gaps.some(gap => gap.code === 'source-outcome'));
  assert.equal(receipt.coverage.complete, false);
  assert.equal(receipt.coverage.pagination.completed, true);
  assert.deepEqual(receipt.coverage.pagination.pageUrls.map(url => new URL(url).searchParams.get('token')), [null, 'scope-a']);
  assert.deepEqual(receipt.coverage.total, { value: 2, basis: 'source-declared-only' });

  const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
  assert.deepEqual(saved.records, receipt.records);
  assert.deepEqual(saved.coverage, receipt.coverage);
}));

test('结构化收件：分页按来源 next 链接上下文继续', withService('clean', async service => {
  const { status, receipt } = await intake(service, { mode: 'structured', query: 'page=9&patient=p1' });
  assert.equal(status, 201);
  assert.equal(receipt.state, 'complete');
  assert.equal(receipt.coverage.complete, true);
  assert.deepEqual(receipt.coverage.gaps, []);
  assert.equal(receipt.coverage.counts.match, 2);
  assert.equal(receipt.coverage.counts.include, 2);
  assert.equal(receipt.coverage.counts.duplicateEntries, 0);
  assert.equal(receipt.coverage.pagination.nextFollowed, 1);
  assert.equal(receipt.coverage.pagination.completed, true);

  const fhirCalls = service.gateway.trace.filter(item => item.path === '/fhir');
  assert.equal(fhirCalls.length, 2);
  assert.equal(fhirCalls[0].query.patient, 'p1');
  assert.equal(fhirCalls[0].query.page, '1');
  assert.equal(fhirCalls[1].query.token, 'scope-b');
  assert.equal(fhirCalls[1].query.patient, undefined);

  const first = new URL(receipt.coverage.pagination.initialUrl);
  assert.equal(first.searchParams.get('page'), '1');
  assert.equal(first.searchParams.get('patient'), 'p1');
  assert.ok(receipt.records.every(record => record.references.every(reference => reference.resolved)));
}));

test('结构化收件：来源字节与版本证据可从收件目录读取', withService('clean', async service => {
  const { receipt } = await intake(service);
  assert.equal(receipt.blobs.length, receipt.coverage.pagination.pagesVisited);
  assert.equal(receipt.evidence.pages.length, receipt.coverage.pagination.pagesVisited);
  for (const page of receipt.evidence.pages) {
    assert.match(page.digest, /^[0-9a-f]{64}$/);
    assert.equal(typeof page.etag, 'string');
    assert.ok(receipt.blobs.some(blob => blob.digest === page.digest));
  }
  assert.equal(receipt.evidence.matchingBasis, 'entry.search.mode');
  assert.deepEqual(receipt.evidence.includedIdentities.sort(), ['Organization/o1/_history/1', 'Organization/o2/_history/1']);
}));

test('结构化收件：分页令牌失效保留告警且不宣称完整', withService('expired-next', async service => {
  const { status, receipt } = await intake(service);
  assert.equal(status, 201);
  assert.equal(receipt.state, 'partial');
  assert.equal(receipt.coverage.complete, false);
  assert.equal(receipt.coverage.pagination.completed, false);
  assert.ok(receipt.issues.some(issue => issue.code === 'page-http-error' && /410/.test(issue.diagnostics)));
  assert.ok(receipt.issues.some(issue => issue.code === 'expired' && issue.severity === 'error'));
  assert.ok(receipt.coverage.gaps.some(gap => gap.code === 'page-http-error'));
  assert.equal(receipt.coverage.counts.match, 1);
  assert.ok(receipt.records.every(record => record.basis.page === 1));
}));

test('结构化收件：循环分页与重复页不计作新增记录', withService('looping-next', async service => {
  const { receipt } = await intake(service);
  assert.equal(receipt.state, 'partial');
  assert.equal(receipt.coverage.pagination.completed, false);
  assert.equal(receipt.coverage.pagination.pagesVisited, 2);
  assert.equal(receipt.coverage.counts.uniqueResources, 2);
  assert.equal(receipt.coverage.counts.match, 1);
  assert.ok(receipt.issues.some(issue => issue.code === 'duplicate-page'));
  assert.ok(receipt.coverage.gaps.some(gap => gap.code === 'duplicate-page'));
  assert.equal(receipt.evidence.pages[1].duplicateOf, 1);
  assert.equal(receipt.evidence.pages[1].accepted, false);
}));

test('结构化收件：版本化引用精确匹配，缺失版本不自动替换', withService('version-mismatch', async service => {
  const { receipt } = await intake(service);
  const reference = receipt.records.find(record => record.mode === 'match').references[0];
  assert.equal(reference.versioned, true);
  assert.equal(reference.resolved, false);
  assert.equal(reference.reason, 'version-not-present');
  assert.equal(receipt.coverage.references.versionMismatch, 1);
  assert.ok(receipt.issues.some(issue => issue.code === 'reference-version-mismatch' && issue.severity === 'warning'));
  assert.equal(receipt.state, 'partial');
}));

test('结构化收件：未指定版本的引用遇到多版本时不擅自选择', withService('ambiguous-versions', async service => {
  const { receipt } = await intake(service);
  const reference = receipt.records.find(record => record.mode === 'match').references[0];
  assert.equal(reference.versioned, false);
  assert.equal(reference.resolved, false);
  assert.equal(reference.reason, 'ambiguous-unversioned');
  assert.equal(receipt.coverage.references.ambiguous, 1);
  assert.equal(receipt.coverage.counts.include, 2);
  assert.ok(receipt.issues.some(issue => issue.code === 'ambiguous-unversioned-reference'));
  assert.equal(receipt.state, 'partial');
}));

test('结构化收件：缺少或无法识别的搜索方式均不冒充命中', withService('unknown-mode', async service => {
  const { receipt } = await intake(service);
  assert.equal(receipt.coverage.counts.unknown, 2);
  assert.deepEqual(receipt.coverage.unknownEntries.map(entry => entry.identity).sort(),
    ['Patient/p10/_history/1', 'Patient/p9/_history/1']);
  assert.equal(receipt.coverage.unknownEntries.find(entry => entry.identity.startsWith('Patient/p9')).basis, null);
  assert.equal(receipt.coverage.unknownEntries.find(entry => entry.identity.startsWith('Patient/p10')).basis, 'other');
  assert.equal(receipt.coverage.counts.match, 1);
  assert.equal(receipt.coverage.counts.include, 1);
  assert.ok(!receipt.records.some(record => ['p9', 'p10'].includes(record.id)));
  assert.equal(receipt.state, 'partial');
  assert.ok(receipt.issues.some(issue => issue.code === 'entry-mode-unknown' && /other/.test(issue.diagnostics)));
  assert.ok(receipt.coverage.gaps.some(gap => gap.code === 'entry-mode-unknown'));
}));

test('结构化收件：来源以外的分页链接不跟随', withService('outside-next', async service => {
  const { receipt } = await intake(service);
  assert.equal(receipt.state, 'partial');
  assert.equal(receipt.coverage.pagination.nextFollowed, 0);
  assert.equal(receipt.coverage.pagination.pagesVisited, 1);
  assert.equal(service.gateway.trace.filter(item => item.path === '/fhir').length, 1);
  assert.ok(receipt.issues.some(issue => issue.code === 'next-link-outside-source'));
  assert.ok(receipt.coverage.gaps.some(gap => gap.code === 'next-link-outside-source'));
}));

test('结构化收件：局部读取失败保留已读片段与原文告警', withService('truncated-page', async service => {
  const { receipt } = await intake(service);
  assert.equal(receipt.state, 'partial');
  assert.equal(receipt.coverage.pagination.completed, false);
  assert.ok(receipt.issues.some(issue => issue.code === 'page-read-failed'));
  assert.equal(receipt.coverage.counts.match, 1);
  assert.equal(receipt.coverage.counts.include, 1);
  assert.equal(receipt.evidence.pages.length, 2);
  assert.equal(receipt.evidence.pages[1].accepted, false);
  assert.equal(receipt.blobs.length, 2);
  assert.ok(receipt.coverage.gaps.some(gap => gap.code === 'page-read-failed'));
}));

test('结构化收件：初页不可用时形成 rejected 收件并保留来源响应', withService('source-unavailable', async service => {
  const { status, receipt } = await intake(service);
  assert.equal(status, 201);
  assert.equal(receipt.state, 'rejected');
  assert.equal(receipt.coverage.complete, false);
  assert.equal(receipt.records.length, 0);
  assert.equal(receipt.blobs.length, 1);
  assert.equal(receipt.evidence.pages[0].status, 503);
  assert.ok(receipt.issues.some(issue => issue.code === 'page-http-error'));
  assert.ok(receipt.coverage.gaps.some(gap => gap.code === 'page-http-error'));
  const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
  assert.equal(saved.state, 'rejected');
}));

test('结构化收件：同一 DATA_DIR 重启后仍可查询既有结果', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-restart-'));
  let service = await createService({ dataDir });
  let receipt;
  try {
    ({ receipt } = await intake(service));
    assert.equal(receipt.state, 'partial');
  } finally { await service.close(); }
  service = await createService({ dataDir, scenario: 'clean' });
  try {
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.equal(saved.id, receipt.id);
    assert.equal(saved.coverage.counts.crossPageDuplicates, 1);
    assert.deepEqual(saved.records.map(record => [record.mode, record.identity]), receipt.records.map(record => [record.mode, record.identity]));
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});
