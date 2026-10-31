import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const SERVER_PATH = path.join(SERVER_DIR, 'server.mjs');

let apiServer;
let endpoint;
const capturedRequests = [];

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

before(async () => {
  apiServer = http.createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    capturedRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      bodyText,
    });

    const url = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'POST' && url.pathname === '/v4/project') {
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        jsonResponse(response, 400, {
          error_code: 'PM.00000000',
          error_msg: 'invalid json',
        });
        return;
      }

      if (body.project_name === 'bad-project') {
        jsonResponse(response, 400, {
          error_code: 'PM.00000001',
          error_msg: '项目名称已存在',
        });
        return;
      }

      jsonResponse(response, 200, {
        description: body.description ?? '',
        project_id: 'project-uuid',
        project_num_id: 123,
        project_name: body.project_name,
        project_type: body.project_type,
        user_num_id: 456,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v4/projects') {
      if (url.searchParams.get('search') === 'bad-search') {
        jsonResponse(response, 403, {
          error_code: 'PM.00000003',
          error_msg: '没有项目查询权限',
        });
        return;
      }

      jsonResponse(response, 200, {
        projects: [
          {
            project_id: 'project-uuid',
            project_name: 'demo-project',
            project_type: 'scrum',
          },
        ],
        total: 1,
      });
      return;
    }

    jsonResponse(response, 404, {
      error_code: 'APIG.0101',
      error_msg: 'not found',
    });
  });

  await new Promise((resolve, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(0, '127.0.0.1', resolve);
  });

  endpoint = `http://127.0.0.1:${apiServer.address().port}`;
});

after(async () => {
  if (!apiServer) return;
  if (typeof apiServer.closeAllConnections === 'function') {
    apiServer.closeAllConnections();
  }
  await new Promise((resolve) => apiServer.close(resolve));
});

async function withClient(environment, callback) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: SERVER_DIR,
    env: environment,
    stderr: 'pipe',
  });

  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client(
    { name: 'codearts-req-test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    return await callback(client);
  } catch (error) {
    if (stderr) {
      error.message = `${error.message}\n[server stderr]\n${stderr}`;
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

function parseResult(result) {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, 'text');
  return {
    isError: result.isError,
    data: JSON.parse(result.content[0].text),
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 在测试侧独立重算 SDK-HMAC-SHA256，验证服务实际发出的
 * host、路径、查询串、请求体与 Authorization 签名一致。
 */
function verifyActualRequestSignature(request) {
  const authorization = request.headers.authorization;
  const match =
    /^SDK-HMAC-SHA256 Access=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      authorization ?? ''
    );
  assert.ok(match, `Authorization 格式不正确: ${authorization}`);

  const [, access, signedHeaders, actualSignature] = match;
  assert.equal(access, 'AKTEST');

  const url = new URL(request.url, endpoint);
  const canonicalPath = url.pathname.endsWith('/')
    ? url.pathname
    : `${url.pathname}/`;
  const canonicalQuery = url.search.startsWith('?')
    ? url.search.slice(1)
    : '';

  const headerValues = {
    'content-type': request.headers['content-type'],
    host: request.headers.host,
    'x-sdk-date': request.headers['x-sdk-date'],
  };

  const headerNames = signedHeaders.split(';');
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${String(headerValues[name]).trim()}\n`)
    .join('');

  const canonicalRequest = [
    request.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256(request.bodyText),
  ].join('\n');

  const stringToSign = [
    'SDK-HMAC-SHA256',
    request.headers['x-sdk-date'],
    sha256(canonicalRequest),
  ].join('\n');

  const expectedSignature = createHmac(
    'sha256',
    Buffer.from('SKTEST', 'utf8')
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  assert.equal(actualSignature, expectedSignature);
}

const ENV = {
  CODEARTS_REQ_ENDPOINT: '',
  CODEARTS_REQ_AK: 'AKTEST',
  CODEARTS_REQ_SK: 'SKTEST',
};

function fullEnv() {
  return { ...ENV, CODEARTS_REQ_ENDPOINT: endpoint };
}

describe('MCP stdio 协议集成', () => {
  test('tools/list 暴露两个工具及正确的 JSON Schema', { timeout: 20_000 }, async () => {
    await withClient(fullEnv(), async (client) => {
      const result = await client.listTools();
      const tools = result.tools;
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['create_project', 'list_projects']
      );

      const createTool = tools.find((tool) => tool.name === 'create_project');
      assert.deepEqual(createTool.inputSchema.required, [
        'project_name',
        'project_type',
      ]);
      assert.deepEqual(createTool.inputSchema.properties.project_type.enum, [
        'scrum',
        'normal',
        'xboard',
        'basic',
        'phoenix',
        'ipd',
      ]);
      assert.deepEqual(createTool.inputSchema.properties.template_id.enum, [
        10001,
        10002,
        10003,
      ]);

      const listTool = tools.find((tool) => tool.name === 'list_projects');
      assert.deepEqual(listTool.inputSchema.properties.project_type.enum, [
        'scrum',
        'normal',
        'xboard',
      ]);
      assert.equal(listTool.inputSchema.properties.offset.default, 0);
      assert.equal(listTool.inputSchema.properties.limit.default, 10);
    });
  });

  test('create_project 通过 stdio 调用并发送正确请求体', { timeout: 20_000 }, async () => {
    capturedRequests.length = 0;

    await withClient(fullEnv(), async (client) => {
      const result = parseResult(
        await client.callTool({
          name: 'create_project',
          arguments: {
            project_name: 'demo-project',
            project_type: 'ipd',
            description: '通过 MCP 创建',
            enterprise_id: 'enterprise-1',
            source: 'codearts-req-mcp',
            template_id: 10002,
          },
        })
      );

      assert.equal(result.isError, false);
      assert.deepEqual(result.data, {
        project_id: 'project-uuid',
        project_num_id: 123,
        project_name: 'demo-project',
        project_type: 'ipd',
        user_num_id: 456,
      });
    });

    assert.equal(capturedRequests.length, 1);
    const request = capturedRequests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v4/project');
    assert.match(
      request.headers.authorization,
      /^SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders=content-type;host;x-sdk-date, Signature=[0-9a-f]{64}$/
    );
    assert.match(request.headers['x-sdk-date'], /^\d{8}T\d{6}Z$/);
    assert.equal(request.headers['content-type'], 'application/json');
    verifyActualRequestSignature(request);
    assert.deepEqual(JSON.parse(request.bodyText), {
      project_name: 'demo-project',
      project_type: 'ipd',
      description: '通过 MCP 创建',
      enterprise_id: 'enterprise-1',
      source: 'codearts-req-mcp',
      template_id: 10002,
    });
  });

  test('list_projects 转发全部查询参数并返回 projects/total', { timeout: 20_000 }, async () => {
    capturedRequests.length = 0;

    await withClient(fullEnv(), async (client) => {
      const result = parseResult(
        await client.callTool({
          name: 'list_projects',
          arguments: {
            offset: 10,
            limit: 10,
            search: 'demo 项目',
            project_type: 'scrum',
            sort: 'name:asc, created_on:desc',
            archive: false,
            query_type: 'domain_projects',
          },
        })
      );

      assert.equal(result.isError, false);
      assert.deepEqual(result.data, {
        projects: [
          {
            project_id: 'project-uuid',
            project_name: 'demo-project',
            project_type: 'scrum',
          },
        ],
        total: 1,
      });
    });

    assert.equal(capturedRequests.length, 1);
    const request = capturedRequests[0];
    assert.equal(request.method, 'GET');
    const url = new URL(request.url, endpoint);
    assert.equal(url.pathname, '/v4/projects');
    assert.equal(url.searchParams.get('offset'), '10');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('search'), 'demo 项目');
    assert.equal(url.searchParams.get('project_type'), 'scrum');
    assert.equal(url.searchParams.get('sort'), 'name:asc,created_on:desc');
    assert.equal(url.searchParams.get('archive'), 'false');
    assert.equal(url.searchParams.get('query_type'), 'domain_projects');
    assert.match(request.headers.authorization, /Access=AKTEST/);
    verifyActualRequestSignature(request);
  });

  test('API 400 会以 isError=true 透传且服务不退出', { timeout: 20_000 }, async () => {
    capturedRequests.length = 0;

    await withClient(fullEnv(), async (client) => {
      const result = parseResult(
        await client.callTool({
          name: 'create_project',
          arguments: {
            project_name: 'bad-project',
            project_type: 'scrum',
          },
        })
      );

      assert.equal(result.isError, true);
      assert.deepEqual(result.data, {
        error_code: 'PM.00000001',
        error_msg: '项目名称已存在',
        http_status: 400,
      });

      // 后续调用仍然正常，说明错误没有拖垮进程。
      const afterError = parseResult(
        await client.callTool({
          name: 'list_projects',
          arguments: {},
        })
      );
      assert.equal(afterError.isError, false);
    });

    assert.equal(capturedRequests.length, 2);
  });

  test('参数非法返回 INVALID_ARGUMENTS，且不访问 API', { timeout: 20_000 }, async () => {
    capturedRequests.length = 0;

    await withClient(fullEnv(), async (client) => {
      const result = parseResult(
        await client.callTool({
          name: 'list_projects',
          arguments: { limit: 0 },
        })
      );

      assert.equal(result.isError, true);
      assert.equal(result.data.error_code, 'INVALID_ARGUMENTS');
      assert.match(result.data.details.join('\n'), /limit/);
    });

    assert.equal(capturedRequests.length, 0);
  });

  test('缺配置时服务仍可启动，工具返回 MISSING_CONFIG', { timeout: 20_000 }, async () => {
    capturedRequests.length = 0;

    await withClient({}, async (client) => {
      const result = parseResult(
        await client.callTool({
          name: 'list_projects',
          arguments: {},
        })
      );

      assert.equal(result.isError, true);
      assert.equal(result.data.error_code, 'MISSING_CONFIG');
      assert.deepEqual(result.data.missing, [
        'CODEARTS_REQ_ENDPOINT',
        'CODEARTS_REQ_AK',
        'CODEARTS_REQ_SK',
      ]);
    });

    assert.equal(capturedRequests.length, 0);
  });
});
