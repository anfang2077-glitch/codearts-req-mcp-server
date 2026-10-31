import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildCreateProjectBody,
  buildListProjectsQuery,
  getConfig,
  handleCreateProject,
  handleListProjects,
  validateCreateProject,
  validateListProjects,
} from '../server.mjs';

const ENV = Object.freeze({
  CODEARTS_REQ_ENDPOINT:
    'https://projectman-ext.cn-north-4.myhuaweicloud.com',
  CODEARTS_REQ_AK: 'AKTEST',
  CODEARTS_REQ_SK: 'SKTEST',
});

function parseToolResult(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return {
    isError: result.isError,
    data: JSON.parse(result.content[0].text),
  };
}

function responseLike(status, body) {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

describe('getConfig', () => {
  test('缺少全部环境变量时返回三个名称', () => {
    const config = getConfig({});
    assert.deepEqual(config.missing, [
      'CODEARTS_REQ_ENDPOINT',
      'CODEARTS_REQ_AK',
      'CODEARTS_REQ_SK',
    ]);
    assert.deepEqual(config.invalid, []);
  });

  test('完整配置通过校验并去除首尾空白', () => {
    const config = getConfig({
      CODEARTS_REQ_ENDPOINT: `  ${ENV.CODEARTS_REQ_ENDPOINT}  `,
      CODEARTS_REQ_AK: ' AKTEST ',
      CODEARTS_REQ_SK: ' SKTEST ',
    });
    assert.equal(config.endpoint, ENV.CODEARTS_REQ_ENDPOINT);
    assert.equal(config.ak, 'AKTEST');
    assert.equal(config.sk, 'SKTEST');
    assert.deepEqual(config.missing, []);
    assert.deepEqual(config.invalid, []);
  });

  test('非法终端节点归入 invalid', () => {
    const config = getConfig({
      ...ENV,
      CODEARTS_REQ_ENDPOINT: 'ftp://example.com',
    });
    assert.equal(config.invalid.length, 1);
    assert.equal(config.invalid[0].name, 'CODEARTS_REQ_ENDPOINT');
  });
});

describe('validateCreateProject', () => {
  test('最小合法参数', () => {
    assert.deepEqual(
      validateCreateProject({ project_name: '项目 A', project_type: 'scrum' }),
      []
    );
  });

  test('project_name 边界：1 与 128 字符，129 字符非法', () => {
    assert.deepEqual(
      validateCreateProject({
        project_name: '汉',
        project_type: 'normal',
      }),
      []
    );
    assert.deepEqual(
      validateCreateProject({
        project_name: '汉'.repeat(128),
        project_type: 'normal',
      }),
      []
    );
    assert.ok(
      validateCreateProject({
        project_name: '汉'.repeat(129),
        project_type: 'normal',
      }).some((error) => error.includes('project_name'))
    );
  });

  test('project_name 为空、非字符串或缺失均非法', () => {
    for (const project_name of ['', undefined, 123, null]) {
      assert.ok(
        validateCreateProject({ project_name, project_type: 'scrum' }).some(
          (error) => error.includes('project_name')
        )
      );
    }
  });

  test('project_type 枚举与必填', () => {
    for (const project_type of [
      'scrum',
      'normal',
      'xboard',
      'basic',
      'phoenix',
    ]) {
      assert.deepEqual(
        validateCreateProject({ project_name: 'p', project_type }),
        []
      );
    }
    assert.ok(
      validateCreateProject({ project_name: 'p', project_type: 'ipd' }).some(
        (error) => error.includes('template_id')
      )
    );
    assert.ok(
      validateCreateProject({ project_name: 'p', project_type: 'bad' }).some(
        (error) => error.includes('project_type')
      )
    );
  });

  test('ipd 必须提供 template_id，且数字字符串会被接受', () => {
    assert.deepEqual(
      validateCreateProject({
        project_name: 'p',
        project_type: 'ipd',
        template_id: 10001,
      }),
      []
    );
    assert.deepEqual(
      validateCreateProject({
        project_name: 'p',
        project_type: 'ipd',
        template_id: '10003',
      }),
      []
    );
    assert.ok(
      validateCreateProject({
        project_name: 'p',
        project_type: 'ipd',
        template_id: 999,
      }).some((error) => error.includes('template_id'))
    );
  });

  test('source 为 0-64 字符，65 字符非法', () => {
    assert.deepEqual(
      validateCreateProject({
        project_name: 'p',
        project_type: 'scrum',
        source: '',
      }),
      []
    );
    assert.ok(
      validateCreateProject({
        project_name: 'p',
        project_type: 'scrum',
        source: 'x'.repeat(65),
      }).some((error) => error.includes('source'))
    );
  });

  test('description/enterprise_id 类型校验', () => {
    const errors = validateCreateProject({
      project_name: 'p',
      project_type: 'scrum',
      description: 1,
      enterprise_id: false,
    });
    assert.ok(errors.some((error) => error.includes('description')));
    assert.ok(errors.some((error) => error.includes('enterprise_id')));
  });
});

describe('validateListProjects', () => {
  test('空参数使用默认值', () => {
    assert.deepEqual(validateListProjects({}), []);
  });

  test('limit 边界 1-1000', () => {
    assert.deepEqual(validateListProjects({ limit: 1 }), []);
    assert.deepEqual(validateListProjects({ limit: 1000 }), []);
    assert.ok(validateListProjects({ limit: 0 }).length > 0);
    assert.ok(validateListProjects({ limit: 1001 }).length > 0);
    assert.ok(validateListProjects({ limit: 10.5 }).length > 0);
  });

  test('offset 边界 0-10000 且须为 limit 整数倍', () => {
    assert.deepEqual(validateListProjects({ offset: 0 }), []);
    assert.deepEqual(validateListProjects({ offset: 20, limit: 10 }), []);
    assert.deepEqual(validateListProjects({ offset: 10000, limit: 1000 }), []);
    assert.ok(validateListProjects({ offset: 3, limit: 10 }).length > 0);
    assert.ok(validateListProjects({ offset: -1 }).length > 0);
    assert.ok(validateListProjects({ offset: 10001, limit: 1 }).length > 0);
  });

  test('sort 最多 4 组，格式为 字段:asc/desc', () => {
    assert.deepEqual(
      validateListProjects({
        sort: 'name:asc,created_on:desc,memcount:ASC,author_name:DESC',
      }),
      []
    );
    assert.ok(
      validateListProjects({
        sort: 'name:asc,created_on:desc,memcount:asc,author_name:desc,name:asc',
      }).some((error) => error.includes('sort'))
    );
    assert.ok(
      validateListProjects({ sort: 'name' }).some((error) =>
        error.includes('sort')
      )
    );
    assert.ok(
      validateListProjects({ sort: 'name:up' }).some((error) =>
        error.includes('sort')
      )
    );
    assert.ok(
      validateListProjects({ sort: 'name:asc,' }).some((error) =>
        error.includes('sort')
      )
    );
  });

  test('枚举、布尔与字符串类型校验', () => {
    assert.deepEqual(
      validateListProjects({
        project_type: 'xboard',
        archive: false,
        query_type: 'absent',
        search: '',
      }),
      []
    );
    assert.ok(
      validateListProjects({ project_type: 'ipd' }).some((error) =>
        error.includes('project_type')
      )
    );
    assert.ok(
      validateListProjects({ archive: 'yes' }).some((error) =>
        error.includes('archive')
      )
    );
    assert.ok(
      validateListProjects({ query_type: 'bad' }).some((error) =>
        error.includes('query_type')
      )
    );
    assert.ok(
      validateListProjects({ search: 1 }).some((error) =>
        error.includes('search')
      )
    );
  });
});

describe('请求构造', () => {
  test('创建项目 body 只包含显式提供的字段', () => {
    assert.deepEqual(
      buildCreateProjectBody({
        project_name: 'p',
        project_type: 'scrum',
      }),
      { project_name: 'p', project_type: 'scrum' }
    );

    assert.deepEqual(
      buildCreateProjectBody({
        project_name: 'p',
        project_type: 'ipd',
        description: 'd',
        enterprise_id: 'e',
        source: 's',
        template_id: '10002',
      }),
      {
        project_name: 'p',
        project_type: 'ipd',
        description: 'd',
        enterprise_id: 'e',
        source: 's',
        template_id: 10002,
      }
    );
  });

  test('列表 query 带默认分页并保留 false/空字符串', () => {
    assert.deepEqual(buildListProjectsQuery({}), { limit: 10, offset: 0 });
    assert.deepEqual(
      buildListProjectsQuery({
        limit: 5,
        offset: 10,
        search: '',
        project_type: 'scrum',
        sort: 'name:asc, created_on:desc',
        archive: false,
        query_type: 'domain_projects',
      }),
      {
        limit: 5,
        offset: 10,
        search: '',
        project_type: 'scrum',
        sort: 'name:asc,created_on:desc',
        archive: false,
        query_type: 'domain_projects',
      }
    );
  });
});

describe('handleCreateProject', () => {
  test('参数非法返回 INVALID_ARGUMENTS，且不会发起网络请求', async () => {
    let called = false;
    const result = parseToolResult(
      await handleCreateProject(
        { project_name: '', project_type: 'scrum' },
        {
          env: ENV,
          fetchImpl: async () => {
            called = true;
          },
        }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'INVALID_ARGUMENTS');
    assert.ok(Array.isArray(result.data.details));
    assert.equal(called, false);
  });

  test('arguments 非对象时返回 INVALID_ARGUMENTS', async () => {
    const result = parseToolResult(
      await handleCreateProject('bad', { env: ENV })
    );
    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'INVALID_ARGUMENTS');
  });

  test('缺配置返回 MISSING_CONFIG，且不会发起网络请求', async () => {
    let called = false;
    const result = parseToolResult(
      await handleCreateProject(
        { project_name: 'p', project_type: 'scrum' },
        {
          env: {},
          fetchImpl: async () => {
            called = true;
          },
        }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'MISSING_CONFIG');
    assert.deepEqual(result.data.missing, [
      'CODEARTS_REQ_ENDPOINT',
      'CODEARTS_REQ_AK',
      'CODEARTS_REQ_SK',
    ]);
    assert.equal(called, false);
  });

  test('成功时发送签名 POST 并只返回约定字段', async () => {
    let captured;
    const result = parseToolResult(
      await handleCreateProject(
        {
          project_name: 'demo-project',
          project_type: 'scrum',
          description: '演示项目',
          source: 'mcp',
        },
        {
          env: ENV,
          now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
          fetchImpl: async (url, options) => {
            captured = { url, options };
            return responseLike(200, {
              description: '演示项目',
              project_id: 'project-uuid',
              project_num_id: 123,
              project_name: 'demo-project',
              project_type: 'scrum',
              user_num_id: 456,
              extra_field: 'ignored',
            });
          },
        }
      )
    );

    assert.equal(result.isError, false);
    assert.deepEqual(result.data, {
      project_id: 'project-uuid',
      project_num_id: 123,
      project_name: 'demo-project',
      project_type: 'scrum',
      user_num_id: 456,
    });

    assert.equal(
      captured.url,
      `${ENV.CODEARTS_REQ_ENDPOINT}/v4/project`
    );
    assert.equal(captured.options.method, 'POST');
    assert.equal(
      captured.options.headers['Content-Type'],
      'application/json'
    );
    assert.equal(
      captured.options.headers['X-Sdk-Date'],
      '20260101T000000Z'
    );
    assert.match(
      captured.options.headers.Authorization,
      /^SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders=content-type;host;x-sdk-date, Signature=[0-9a-f]{64}$/
    );
    assert.deepEqual(JSON.parse(captured.options.body), {
      project_name: 'demo-project',
      project_type: 'scrum',
      description: '演示项目',
      source: 'mcp',
    });
    assert.equal(captured.options.redirect, 'manual');
    assert.ok(captured.options.signal instanceof AbortSignal);
  });

  test('API 错误透传 error_code/error_msg/http_status', async () => {
    const result = parseToolResult(
      await handleCreateProject(
        { project_name: 'p', project_type: 'scrum' },
        {
          env: ENV,
          fetchImpl: async () =>
            responseLike(400, {
              error_code: 'PM.00000001',
              error_msg: '项目名称已存在',
            }),
        }
      )
    );

    assert.equal(result.isError, true);
    assert.deepEqual(result.data, {
      error_code: 'PM.00000001',
      error_msg: '项目名称已存在',
      http_status: 400,
    });
  });

  test('网络异常返回 NETWORK_ERROR', async () => {
    const result = parseToolResult(
      await handleCreateProject(
        { project_name: 'p', project_type: 'scrum' },
        {
          env: ENV,
          fetchImpl: async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:443');
          },
        }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'NETWORK_ERROR');
    assert.match(result.data.detail, /ECONNREFUSED/);
  });

  test('请求超时返回 NETWORK_ERROR', async () => {
    const result = parseToolResult(
      await handleCreateProject(
        { project_name: 'p', project_type: 'scrum' },
        {
          env: ENV,
          timeoutMs: 20,
          fetchImpl: async (_url, options) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              });
            }),
        }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'NETWORK_ERROR');
    assert.match(result.data.detail, /超时/);
  });

  test('成功响应缺少 project_id 视为异常响应', async () => {
    const result = parseToolResult(
      await handleCreateProject(
        { project_name: 'p', project_type: 'scrum' },
        {
          env: ENV,
          fetchImpl: async () => responseLike(200, { project_name: 'p' }),
        }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'API_ERROR');
    assert.match(result.data.error_msg, /project_id/);
  });

  test('2xx 非 JSON 视为异常响应', async () => {
    const result = parseToolResult(
      await handleCreateProject(
        { project_name: 'p', project_type: 'scrum' },
        {
          env: ENV,
          fetchImpl: async () => responseLike(200, '<html>bad gateway</html>'),
        }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'API_ERROR');
    assert.equal(result.data.http_status, 200);
  });
});

describe('handleListProjects', () => {
  test('成功时发送默认分页与全部筛选参数', async () => {
    let captured;
    const result = parseToolResult(
      await handleListProjects(
        {
          offset: 20,
          limit: 10,
          search: 'a b',
          project_type: 'scrum',
          sort: 'name:asc, created_on:desc',
          archive: false,
          query_type: 'domain_projects',
        },
        {
          env: ENV,
          fetchImpl: async (url, options) => {
            captured = { url, options };
            return responseLike(200, {
              projects: [{ project_id: 'p1', project_name: '项目一' }],
              total: 1,
            });
          },
        }
      )
    );

    assert.equal(result.isError, false);
    assert.deepEqual(result.data, {
      projects: [{ project_id: 'p1', project_name: '项目一' }],
      total: 1,
    });

    const url = new URL(captured.url);
    assert.equal(url.origin, ENV.CODEARTS_REQ_ENDPOINT);
    assert.equal(url.pathname, '/v4/projects');
    assert.equal(url.searchParams.get('offset'), '20');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('search'), 'a b');
    assert.equal(url.searchParams.get('project_type'), 'scrum');
    assert.equal(url.searchParams.get('sort'), 'name:asc,created_on:desc');
    assert.equal(url.searchParams.get('archive'), 'false');
    assert.equal(url.searchParams.get('query_type'), 'domain_projects');

    assert.equal(captured.options.method, 'GET');
    assert.equal(captured.options.body, undefined);
    assert.match(
      captured.options.headers.Authorization,
      /SignedHeaders=content-type;host;x-sdk-date/
    );
  });

  test('默认分页为 offset=0&limit=10', async () => {
    let capturedUrl;
    const result = parseToolResult(
      await handleListProjects(
        {},
        {
          env: ENV,
          fetchImpl: async (url) => {
            capturedUrl = url;
            return responseLike(200, { projects: [], total: 0 });
          },
        }
      )
    );

    assert.equal(result.isError, false);
    assert.deepEqual(result.data, { projects: [], total: 0 });
    assert.equal(
      new URL(capturedUrl).search,
      '?limit=10&offset=0'
    );
  });

  test('offset 不是 limit 整数倍时返回 INVALID_ARGUMENTS', async () => {
    const result = parseToolResult(
      await handleListProjects(
        { offset: 3, limit: 10 },
        { env: ENV, fetchImpl: async () => responseLike(200, {}) }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'INVALID_ARGUMENTS');
    assert.match(result.data.details.join('\n'), /offset/);
  });

  test('API 错误透传', async () => {
    const result = parseToolResult(
      await handleListProjects(
        {},
        {
          env: ENV,
          fetchImpl: async () =>
            responseLike(401, {
              error_code: 'APIG.0301',
              error_msg: 'Incorrect IAM authentication information',
            }),
        }
      )
    );

    assert.equal(result.isError, true);
    assert.deepEqual(result.data, {
      error_code: 'APIG.0301',
      error_msg: 'Incorrect IAM authentication information',
      http_status: 401,
    });
  });

  test('成功响应 projects/total 类型异常时报 API_ERROR', async () => {
    const result = parseToolResult(
      await handleListProjects(
        {},
        {
          env: ENV,
          fetchImpl: async () =>
            responseLike(200, { projects: 'oops', total: '1' }),
        }
      )
    );

    assert.equal(result.isError, true);
    assert.equal(result.data.error_code, 'API_ERROR');
    assert.match(result.data.error_msg, /projects/);
  });
});
