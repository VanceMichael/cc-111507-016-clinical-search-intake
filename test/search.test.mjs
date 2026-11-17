import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';


async function intake(service, input = {}) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'structured', ...input }),
  });
  return { response, receipt: await response.json() };
}

async function withService(scenario, run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'search-test-'));
  const service = await createService({ dataDir, scenario });
  try { await run(service, dataDir); }
  finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
}

test('结构化检索：按 search.mode 区分命中与附带资源，统计不混算', async () => {
  await withService('standard', async service => {
    const { response, receipt } = await intake(service);
    assert.equal(response.status, 201);
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.coverage.complete, false);
    assert.equal(receipt.records.filter(record => record.mode === 'match').length, 2);
    assert.equal(receipt.records.filter(record => record.mode === 'include').length, 1);
    assert.equal(receipt.coverage.counts.matchEntries, 2);
    assert.equal(receipt.coverage.counts.includeEntries, 2);
    assert.equal(receipt.coverage.counts.outcomeEntries, 1);
    assert.equal(receipt.coverage.counts.includeResources, 1);
    // o1 在两页各出现一次 include，只算一个服务对象。
    assert.equal(receipt.coverage.counts.duplicateIncludeEntries, 1);
    assert.equal(receipt.coverage.counts.includeObjects, 1);
    assert.ok(!receipt.records.some(record => record.resourceType === 'OperationOutcome'));
    assert.ok(receipt.issues.every(issue => issue.code !== 'source-outcome' || issue.severity === 'warning'));
    assert.ok(receipt.issues.some(issue => issue.code === 'source-outcome' && issue.diagnostics === '来源保留未决结果'));
  });
});

test('结构化检索：分页沿来源 next 链接并保留查询上下文', async () => {
  await withService('standard', async service => {
    const { receipt } = await intake(service, { query: 'category=patient' });
    const trace = service.gateway.trace.filter(item => item.path === '/fhir');
    assert.equal(trace.length, 2);
    assert.equal(trace[0].query.page, '1');
    // 第二页必须使用来源给出的 token 上下文，而不是自行拼 page=2。
    assert.equal(trace[1].query.page, '2');
    assert.equal(trace[1].query.token, 'scope-a');
    assert.equal(receipt.coverage.pages.fetched, 2);
    assert.deepEqual(receipt.coverage.pages.urls, trace.map(item => `${service.gateway.baseUrl}/fhir?${new URLSearchParams(item.query)}`));
    assert.equal(receipt.coverage.scope.nextFollowed, 1);
  });
});

test('结构化检索：请求中的 page 参数不替换来源分页上下文', async () => {
  await withService('standard', async service => {
    const { receipt } = await intake(service, { query: 'page=7&category=patient' });
    assert.equal(receipt.coverage.scope.requestedPageIgnored, true);
    const trace = service.gateway.trace.filter(item => item.path === '/fhir');
    assert.equal(trace[0].query.page, '1');
    assert.equal(trace[0].query.category, 'patient');
  });
});

test('结构化检索：next 指向来源之外时不访问', async () => {
  await withService('unsafe-next', async service => {
    const { receipt } = await intake(service);
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.coverage.pages.fetched, 1);
    assert.ok(receipt.issues.some(issue => issue.code === 'unsafe-next-link' && issue.severity === 'error'));
    assert.ok(!service.gateway.trace.some(item => item.query.page === '2'));
  });
});

test('结构化检索：next 循环不视作完整且不重复计数', async () => {
  await withService('cyclic-next', async service => {
    const { receipt } = await intake(service);
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.coverage.complete, false);
    assert.equal(receipt.coverage.pages.loopDetected, true);
    assert.equal(receipt.coverage.counts.matchResources, 2);
    assert.equal(receipt.coverage.counts.includeResources, 1);
    assert.ok(receipt.issues.some(issue => issue.code === 'looping-next'));
    // 两次真正读取后停止，不重复请求同一页。
    const pages = service.gateway.trace.filter(item => item.path === '/fhir');
    assert.equal(pages.length, 2);
    assert.equal(receipt.coverage.pages.urls.length, 2);
  });
});

test('结构化检索：重复分页不会被当成新增记录', async () => {
  await withService('duplicate-page', async service => {
    const { receipt } = await intake(service);
    assert.equal(receipt.coverage.pages.duplicate.length, 1);
    assert.equal(receipt.coverage.pages.exhausted, false);
    assert.equal(receipt.coverage.complete, false);
    assert.equal(receipt.coverage.counts.matchResources, 1);
    assert.ok(receipt.issues.some(issue => issue.code === 'duplicate-page'));
  });
});

test('结构化检索：分页失败保留告警与已取得的部分结果', async () => {
  await withService('expired-next', async service => {
    const { receipt } = await intake(service);
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.coverage.complete, false);
    assert.equal(receipt.coverage.pages.failed.length, 1);
    assert.equal(receipt.coverage.pages.failed[0].status, 410);
    assert.ok(receipt.issues.some(issue => issue.code === 'source-outcome' && issue.severity === 'error'));
    assert.equal(receipt.records.filter(record => record.mode === 'match').length, 1);
    // 已取得的分页仍保留来源字节。
    assert.ok(receipt.blobs.length >= 2);
  });
});

test('结构化检索：入口不是 Bundle 时形成 rejected 而不是伪造记录', async () => {
  await withService('not-a-bundle', async service => {
    const { receipt } = await intake(service);
    assert.equal(receipt.state, 'rejected');
    assert.equal(receipt.records.length, 0);
    assert.equal(receipt.coverage.complete, false);
    assert.ok(receipt.issues.some(issue => issue.code === 'invalid-bundle'));
    // 原文仍按字节保存。
    assert.equal(receipt.blobs.length, 1);
  });
});

test('结构化检索：无告警的单页来源可声明 complete', async () => {
  await withService('clean', async service => {
    const { receipt } = await intake(service);
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.coverage.complete, true);
    assert.deepEqual(receipt.coverage.gaps, []);
    assert.equal(receipt.coverage.total.consistent, true);
  });
});

test('结构化检索：版本化引用精确解析，缺版本引用不擅自选版本', async () => {
  await withService('cross-page-references', async service => {
    const { receipt } = await intake(service);
    const [unversioned, versioned] = receipt.evidence.relationships;
    assert.equal(unversioned.reference, 'Organization/o1');
    assert.equal(unversioned.versioned, false);
    assert.equal(unversioned.resolved, false);
    assert.equal(unversioned.resolution, 'ambiguous');
    assert.equal(versioned.reference, 'Organization/o1/_history/1');
    assert.equal(versioned.versioned, true);
    assert.equal(versioned.resolved, true);
    assert.equal(versioned.resolvedIdentity, 'Organization/o1/_history/1');
    // 跨页重复的 include 资源不会新增服务对象。
    const o1 = receipt.records.filter(record => record.objectIdentity === 'Organization/o1');
    assert.equal(o1.length, 2); // 两个版本各一条记录
    assert.equal(receipt.coverage.counts.duplicateIncludeEntries, 1);
    assert.equal(o1.find(record => record.versionId === '1').alsoSeenOn.length, 1);
  });
});

test('结构化检索：包含关系依据与版本统计写入收件', async () => {
  await withService('standard', async service => {
    const { receipt } = await intake(service);
    const organization = receipt.records.find(record => record.identity === 'Organization/o1/_history/1');
    assert.equal(organization.mode, 'include');
    assert.ok(organization.basis.some(basis => basis.type === 'search-mode'));
    assert.ok(organization.basis.some(basis => basis.type === 'reference'
      && basis.resolution === 'exact-version' && basis.from === 'Patient/p1/_history/2'));
    assert.equal(receipt.coverage.relationships.versionedReferences, 1);
    assert.equal(receipt.coverage.relationships.resolved, 1);
  });
});

test('结构化检索：结果可通过收件接口重新读取', async () => {
  await withService('edge-references', async service => {
    const { receipt } = await intake(service);
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
    assert.deepEqual(saved.coverage, receipt.coverage);
    assert.deepEqual(saved.evidence, receipt.evidence);
    assert.equal(saved.mode, 'structured');
    const listed = await (await fetch(`${service.baseUrl}/v1/receipts`)).json();
    assert.equal(listed.length, 1);
  });
});
