import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReference, collectReferenceTexts, resolveRecordReferences } from '../src/references.mjs';

test('引用解析区分相对、版本化、别名与包含引用', () => {
  assert.deepEqual(parseReference('Patient/p1/_history/2'), {
    kind: 'relative', resourceType: 'Patient', id: 'p1', version: '2', absolute: null, raw: 'Patient/p1/_history/2',
  });
  const absolute = parseReference('https://source.example/fhir/Organization/o1');
  assert.equal(absolute.kind, 'relative');
  assert.equal(absolute.resourceType, 'Organization');
  assert.equal(absolute.absolute, 'https://source.example');
  assert.equal(parseReference('urn:uuid:x').kind, 'alias');
  assert.equal(parseReference('#c1').kind, 'contained');
  assert.equal(parseReference('').kind, 'empty');
});

test('引用文本从嵌套结构中收集且去重', () => {
  const resource = {
    managingOrganization: { reference: 'Organization/o1/_history/1' },
    generalPractitioner: [{ reference: 'urn:uuid:o2' }, { identifier: { value: 'no-reference' } }],
    extension: [{ valueReference: { reference: 'Organization/o1/_history/1' } }],
  };
  assert.deepEqual(collectReferenceTexts(resource), ['Organization/o1/_history/1', 'urn:uuid:o2']);
});

test('版本化引用不匹配时不自动替换，缺少版本且有多个版本时不猜测', () => {
  const records = [
    { identity: 'Patient/p1/_history/2', mode: 'match', resourceType: 'Patient', id: 'p1', version: '2',
      resource: { resourceType: 'Patient', id: 'p1', managingOrganization: { reference: 'Organization/o1/_history/3' },
        generalPractitioner: [{ reference: 'Organization/o1' }],
        contained: [{ resourceType: 'Organization', id: 'inner' }],
        extension: [{ valueReference: { reference: 'Organization/o1/_history/1' } }] } },
    { identity: 'Organization/o1/_history/1', mode: 'include', resourceType: 'Organization', id: 'o1', version: '1', resource: {} },
    { identity: 'Organization/o1/_history/2', mode: 'include', resourceType: 'Organization', id: 'o1', version: '2', resource: {} },
  ];
  const result = resolveRecordReferences(records, { aliases: new Map(), sourceOrigin: 'https://source.example' });
  const references = records[0].references;
  assert.equal(references.length, 3);
  const versionedMissing = references.find(item => item.reference === 'Organization/o1/_history/3');
  assert.equal(versionedMissing.resolved, false);
  assert.equal(versionedMissing.reason, 'version-not-present');
  const versionedHit = references.find(item => item.reference === 'Organization/o1/_history/1');
  assert.equal(versionedHit.resolved, true);
  assert.equal(versionedHit.targetIdentity, 'Organization/o1/_history/1');
  const unversioned = references.find(item => item.reference === 'Organization/o1');
  assert.equal(unversioned.resolved, false);
  assert.equal(unversioned.reason, 'ambiguous-unversioned');
  assert.equal(result.stats.versionMismatch, 1);
  assert.equal(result.stats.ambiguous, 1);
  assert.ok(result.issues.some(issue => issue.code === 'reference-version-mismatch'));
  assert.ok(result.issues.some(issue => issue.code === 'ambiguous-unversioned-reference'));
});
