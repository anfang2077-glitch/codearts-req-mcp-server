import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildSignedHeaders,
  canonicalHeaders,
  canonicalQueryString,
  canonicalUri,
  normalizeEndpoint,
  utcDateTime,
} from '../server.mjs';

describe('canonicalQueryString', () => {
  test('空查询返回空字符串', () => {
    assert.equal(canonicalQueryString(null), '');
    assert.equal(canonicalQueryString(undefined), '');
    assert.equal(canonicalQueryString({}), '');
  });

  test('按参数名升序排序', () => {
    assert.equal(
      canonicalQueryString({ offset: 0, limit: 10, search: 'demo' }),
      'limit=10&offset=0&search=demo'
    );
  });

  test('保留空值与 false，不静默丢弃', () => {
    assert.equal(
      canonicalQueryString({ empty: '', archive: false, skip: undefined }),
      'archive=false&empty='
    );
  });

  test('RFC3986 编码：空格为 %20，特殊字符大写十六进制', () => {
    assert.equal(
      canonicalQueryString({ q: "a b&c/中文!*()'" }),
      'q=a%20b%26c%2F%E4%B8%AD%E6%96%87%21%2A%28%29%27'
    );
  });

  test('大写参数名排在小写参数名前（字符代码顺序）', () => {
    assert.equal(canonicalQueryString({ b: 1, A: 2 }), 'A=2&b=1');
  });
});

describe('canonicalUri', () => {
  test('签名 URI 必须以 / 结尾', () => {
    assert.equal(canonicalUri('/v4/project'), '/v4/project/');
    assert.equal(canonicalUri('/v4/projects/'), '/v4/projects/');
  });

  test('补全前导斜杠，空路径为 /', () => {
    assert.equal(canonicalUri('v4/projects'), '/v4/projects/');
    assert.equal(canonicalUri(''), '/');
  });
});

describe('canonicalHeaders', () => {
  test('名称小写、排序、值 trim', () => {
    const { canonical, signed } = canonicalHeaders({
      Host: '  example.com  ',
      'X-Sdk-Date': '20260101T000000Z',
      'Content-Type': 'application/json',
    });

    assert.equal(
      signed,
      'content-type;host;x-sdk-date'
    );
    assert.equal(
      canonical,
      'content-type:application/json\n' +
        'host:example.com\n' +
        'x-sdk-date:20260101T000000Z\n'
    );
  });
});

describe('utcDateTime', () => {
  test('输出 YYYYMMDDTHHMMSSZ（UTC）', () => {
    assert.equal(
      utcDateTime(new Date(Date.UTC(2026, 0, 1, 9, 8, 7))),
      '20260101T090807Z'
    );
  });
});

describe('normalizeEndpoint', () => {
  test('接受完整 URL 与纯域名', () => {
    assert.deepEqual(
      normalizeEndpoint(
        'https://projectman-ext.cn-north-4.myhuaweicloud.com/'
      ),
      {
        origin: 'https://projectman-ext.cn-north-4.myhuaweicloud.com',
        host: 'projectman-ext.cn-north-4.myhuaweicloud.com',
        basePath: '',
      }
    );

    assert.equal(
      normalizeEndpoint('projectman-ext.cn-north-4.myhuaweicloud.com')
        .origin,
      'https://projectman-ext.cn-north-4.myhuaweicloud.com'
    );
  });

  test('保留基础路径并去掉末尾斜杠', () => {
    const endpoint = normalizeEndpoint('http://127.0.0.1:8080/gateway///');
    assert.equal(endpoint.origin, 'http://127.0.0.1:8080');
    assert.equal(endpoint.basePath, '/gateway');
  });

  test('拒绝查询参数、锚点和账号密码', () => {
    assert.throws(() => normalizeEndpoint('https://example.com?x=1'));
    assert.throws(() => normalizeEndpoint('https://example.com#a'));
    assert.throws(() => normalizeEndpoint('https://u:p@example.com'));
    assert.throws(() => normalizeEndpoint('ftp://example.com'));
  });
});

describe('buildSignedHeaders', () => {
  const fixture = {
    method: 'POST',
    path: '/v4/project',
    query: null,
    body: '{"project_name":"demo-project","project_type":"scrum"}',
    ak: 'AKTEST',
    sk: 'SKTEST',
    host: 'projectman-ext.cn-north-4.myhuaweicloud.com',
    now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
  };

  test('生成固定测试向量（与独立实现比对）', () => {
    const headers = buildSignedHeaders(fixture);

    assert.equal(headers['X-Sdk-Date'], '20260101T000000Z');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(
      headers.Authorization,
      'SDK-HMAC-SHA256 Access=AKTEST, ' +
        'SignedHeaders=content-type;host;x-sdk-date, ' +
        'Signature=56fb5666b9c345b693452dbf5cc0a88be7dc6239f0f652f086d9767c2ca7b180'
    );
  });

  test('GET 请求也签名 content-type、host、x-sdk-date', () => {
    const headers = buildSignedHeaders({
      ...fixture,
      method: 'GET',
      path: '/v4/projects',
      body: '',
      query: { limit: 10, offset: 0 },
    });

    assert.match(
      headers.Authorization,
      /SignedHeaders=content-type;host;x-sdk-date, Signature=[0-9a-f]{64}$/
    );
  });

  test('相同输入签名稳定，不同 SK 签名不同', () => {
    const first = buildSignedHeaders(fixture).Authorization;
    const second = buildSignedHeaders(fixture).Authorization;
    const other = buildSignedHeaders({ ...fixture, sk: 'OTHER' }).Authorization;

    assert.equal(first, second);
    assert.notEqual(first, other);
  });

  test('缺少 host 或 AK/SK 时明确抛错', () => {
    assert.throws(() => buildSignedHeaders({ ...fixture, host: '' }));
    assert.throws(() => buildSignedHeaders({ ...fixture, ak: '' }));
    assert.throws(() => buildSignedHeaders({ ...fixture, sk: '' }));
  });
});
