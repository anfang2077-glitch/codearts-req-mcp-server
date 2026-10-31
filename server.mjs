#!/usr/bin/env node
/**
 * codearts-req —— 华为云 CodeArts 需求管理 MCP Server（本地 stdio）
 *
 * 暴露工具：
 *   - create_project  POST /v4/project
 *   - list_projects   GET  /v4/projects
 *
 * 鉴权：AK/SK + SDK-HMAC-SHA256（Authorization + X-Sdk-Date）
 */
import { createHash, createHmac } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SERVICE_NAME = 'codearts-req';
const SERVICE_VERSION = '1.0.0';
const ALGORITHM = 'SDK-HMAC-SHA256';
const CONTENT_TYPE = 'application/json';
const DEFAULT_TIMEOUT_MS = 30_000;

const CREATE_PROJECT_PATH = '/v4/project';
const LIST_PROJECTS_PATH = '/v4/projects';

const CREATE_PROJECT_TYPES = Object.freeze([
  'scrum',
  'normal',
  'xboard',
  'basic',
  'phoenix',
  'ipd',
]);
const LIST_PROJECT_TYPES = Object.freeze(['scrum', 'normal', 'xboard']);
const TEMPLATE_IDS = Object.freeze([10001, 10002, 10003]);
const QUERY_TYPES = Object.freeze(['domain_projects', 'absent']);

const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  MISSING_CONFIG: 'MISSING_CONFIG',
  NETWORK_ERROR: 'NETWORK_ERROR',
  API_ERROR: 'API_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 按 Unicode 码点计算字符数，避免中文/emoji 被 UTF-16 长度误判。 */
function charLength(value) {
  return Array.from(value).length;
}

/** MCP 的 arguments 必须是对象；undefined/null 视为空参数。 */
function normalizeArguments(args) {
  if (args === undefined || args === null) return {};
  if (!isPlainObject(args)) return null;
  return args;
}

/* -------------------------------------------------------------------------- */
/* 华为云 AK/SK 签名（SDK-HMAC-SHA256）                                        */
/* -------------------------------------------------------------------------- */

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256Hex(key, value) {
  return createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(value, 'utf8')
    .digest('hex');
}

/** RFC 3986 编码：encodeURIComponent 不会编码 !'()*，这里补上。 */
function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * 规范化查询串。
 * 规则：参数名/值做 RFC3986 编码；空值保留为 key=；按编码后的参数名升序排序。
 */
export function canonicalQueryString(query) {
  if (!query || typeof query !== 'object') return '';
  const pairs = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)]);

  if (pairs.length === 0) return '';

  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });

  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/**
 * 规范化消息头：名称转小写并按字符代码排序，值去除首尾空白。
 * 返回的 canonical 末尾带换行，signed 为分号连接的小写头名。
 */
export function canonicalHeaders(headers) {
  const lowered = new Map();
  for (const [name, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    lowered.set(String(name).toLowerCase(), String(value).trim());
  }

  const names = [...lowered.keys()].sort();
  return {
    canonical: names.map((name) => `${name}:${lowered.get(name)}\n`).join(''),
    signed: names.join(';'),
  };
}

/**
 * 规范 URI。
 * 华为云签名规则要求 CanonicalURI 必须以 "/" 结尾，但实际发送的请求可以不带。
 */
export function canonicalUri(requestPath) {
  let value = requestPath || '/';
  if (!value.startsWith('/')) value = `/${value}`;
  if (!value.endsWith('/')) value = `${value}/`;
  return value;
}

/** ISO8601 UTC：YYYYMMDDTHHMMSSZ。 */
export function utcDateTime(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * 生成签名请求头。
 *
 * 固定签名 content-type、host、x-sdk-date。GET 也发送 content-type:
 * application/json，与华为云签名示例保持一致。
 *
 * 返回的对象可以直接交给 fetch；host 由 fetch 根据 URL 自动设置，
 * 因此这里不返回 Host，避免 Node 运行时忽略/重写导致混淆。
 */
export function buildSignedHeaders({
  method,
  path: requestPath,
  query = null,
  body = '',
  ak,
  sk,
  host,
  now = new Date(),
}) {
  if (!host) throw new Error('签名失败：host 不能为空');
  if (!ak || !sk) throw new Error('签名失败：AK/SK 不能为空');

  const xSdkDate = utcDateTime(now);
  const headers = {
    'content-type': CONTENT_TYPE,
    host,
    'x-sdk-date': xSdkDate,
  };

  const { canonical: canonicalHeaderBlock, signed: signedHeaders } =
    canonicalHeaders(headers);
  const payloadHash = sha256Hex(body == null ? '' : String(body));

  const canonicalRequest = [
    String(method || 'GET').toUpperCase(),
    canonicalUri(requestPath),
    canonicalQueryString(query),
    canonicalHeaderBlock,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    xSdkDate,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = hmacSha256Hex(sk, stringToSign);

  return {
    'Content-Type': CONTENT_TYPE,
    'X-Sdk-Date': xSdkDate,
    Authorization:
      `${ALGORITHM} Access=${ak}, SignedHeaders=${signedHeaders}, ` +
      `Signature=${signature}`,
  };
}

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 解析终端节点。允许：
 *   - https://projectman-ext.cn-north-4.myhuaweicloud.com
 *   - projectman-ext.cn-north-4.myhuaweicloud.com（自动补 https://）
 *   - 带基础路径的私有网关地址
 */
export function normalizeEndpoint(rawEndpoint) {
  if (typeof rawEndpoint !== 'string' || rawEndpoint.trim() === '') {
    throw new Error('终端节点为空');
  }

  let raw = rawEndpoint.trim();
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);
  if (!hasScheme) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('不是合法的 HTTP(S) URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http/https 协议');
  }
  if (url.username || url.password) {
    throw new Error('不能在终端节点中包含用户名或密码');
  }
  if (url.search || url.hash) {
    throw new Error('终端节点不能包含查询参数或锚点');
  }

  let basePath = url.pathname.replace(/\/+$/, '');
  if (basePath === '/') basePath = '';

  return {
    origin: url.origin,
    host: url.host,
    basePath,
  };
}

/**
 * 从环境变量读取配置。缺配置不会被当作启动失败，而是在调用工具时
 * 返回结构化的 MISSING_CONFIG，便于 MCP 客户端展示。
 */
export function getConfig(env = process.env) {
  const source = env || {};
  const read = (name) =>
    typeof source[name] === 'string' ? source[name].trim() : '';

  const endpoint = read('CODEARTS_REQ_ENDPOINT');
  const ak = read('CODEARTS_REQ_AK');
  const sk = read('CODEARTS_REQ_SK');

  const missing = [];
  const invalid = [];

  if (!endpoint) missing.push('CODEARTS_REQ_ENDPOINT');
  else {
    try {
      normalizeEndpoint(endpoint);
    } catch (error) {
      invalid.push({
        name: 'CODEARTS_REQ_ENDPOINT',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!ak) missing.push('CODEARTS_REQ_AK');
  if (!sk) missing.push('CODEARTS_REQ_SK');

  return { endpoint, ak, sk, missing, invalid };
}

/* -------------------------------------------------------------------------- */
/* 参数校验                                                                    */
/* -------------------------------------------------------------------------- */

function normalizeTemplateId(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

export function validateCreateProject(args) {
  const errors = [];
  if (!isPlainObject(args)) return ['arguments 必须为 JSON 对象'];

  const {
    project_name,
    project_type,
    description,
    enterprise_id,
    source,
    template_id,
  } = args;

  if (
    typeof project_name !== 'string' ||
    charLength(project_name) < 1 ||
    charLength(project_name) > 128
  ) {
    errors.push('project_name：必填，须为 1-128 字符的字符串');
  }

  if (
    typeof project_type !== 'string' ||
    !CREATE_PROJECT_TYPES.includes(project_type)
  ) {
    errors.push(
      `project_type：必填，取值 ${CREATE_PROJECT_TYPES.join('/')}`
    );
  }

  if (description !== undefined && typeof description !== 'string') {
    errors.push('description：选填，须为字符串');
  }

  if (enterprise_id !== undefined && typeof enterprise_id !== 'string') {
    errors.push('enterprise_id：选填，须为字符串');
  }

  if (
    source !== undefined &&
    (typeof source !== 'string' || charLength(source) > 64)
  ) {
    errors.push('source：选填，须为 0-64 字符的字符串');
  }

  if (template_id !== undefined) {
    const normalized = normalizeTemplateId(template_id);
    if (!TEMPLATE_IDS.includes(normalized)) {
      errors.push(`template_id：选填，取值 ${TEMPLATE_IDS.join('/')}`);
    }
  }

  if (project_type === 'ipd' && template_id === undefined) {
    errors.push('template_id：project_type 为 ipd 时必传，取值 10001/10002/10003');
  }

  return errors;
}

export function validateListProjects(args) {
  const errors = [];
  if (!isPlainObject(args)) return ['arguments 必须为 JSON 对象'];

  const {
    offset,
    limit,
    search,
    project_type,
    sort,
    archive,
    query_type,
  } = args;

  const effectiveLimit = limit === undefined ? 10 : limit;
  const limitValid =
    Number.isInteger(effectiveLimit) &&
    effectiveLimit >= 1 &&
    effectiveLimit <= 1000;

  if (!limitValid) {
    errors.push('limit：选填，须为 1-1000 的整数（默认 10）');
  }

  const effectiveOffset = offset === undefined ? 0 : offset;
  const offsetValid =
    Number.isInteger(effectiveOffset) &&
    effectiveOffset >= 0 &&
    effectiveOffset <= 10000;

  if (!offsetValid) {
    errors.push('offset：选填，须为 0-10000 的整数（默认 0）');
  } else if (limitValid && effectiveOffset % effectiveLimit !== 0) {
    errors.push(
      `offset：须为 limit（当前为 ${effectiveLimit}）的整数倍`
    );
  }

  if (search !== undefined && typeof search !== 'string') {
    errors.push('search：选填，须为字符串');
  }

  if (
    project_type !== undefined &&
    (typeof project_type !== 'string' ||
      !LIST_PROJECT_TYPES.includes(project_type))
  ) {
    errors.push(
      `project_type：选填，取值 ${LIST_PROJECT_TYPES.join('/')}`
    );
  }

  if (sort !== undefined) {
    if (typeof sort !== 'string') {
      errors.push('sort：选填，须为字符串');
    } else {
      const groups = sort.split(',').map((group) => group.trim());
      if (groups.length > 4) {
        errors.push('sort：最多 4 组，使用逗号分隔');
      } else if (
        !groups.every((group) =>
          /^[A-Za-z_][A-Za-z0-9_]*:(asc|desc)$/i.test(group)
        )
      ) {
        errors.push(
          'sort：格式须为 字段:方向（方向为 asc/desc），多组用逗号分隔'
        );
      }
    }
  }

  if (archive !== undefined && typeof archive !== 'boolean') {
    errors.push('archive：选填，须为布尔值');
  }

  if (
    query_type !== undefined &&
    (typeof query_type !== 'string' || !QUERY_TYPES.includes(query_type))
  ) {
    errors.push(`query_type：选填，取值 ${QUERY_TYPES.join('/')}`);
  }

  return errors;
}

/* -------------------------------------------------------------------------- */
/* 请求构造                                                                    */
/* -------------------------------------------------------------------------- */

export function buildCreateProjectBody(args) {
  const body = {
    project_name: args.project_name,
    project_type: args.project_type,
  };

  if (args.description !== undefined) body.description = args.description;
  if (args.enterprise_id !== undefined) body.enterprise_id = args.enterprise_id;
  if (args.source !== undefined) body.source = args.source;
  if (args.template_id !== undefined) {
    body.template_id = normalizeTemplateId(args.template_id);
  }

  return body;
}

export function buildListProjectsQuery(args) {
  const query = {
    limit: args.limit === undefined ? 10 : args.limit,
    offset: args.offset === undefined ? 0 : args.offset,
  };

  if (args.search !== undefined) query.search = args.search;
  if (args.project_type !== undefined) query.project_type = args.project_type;
  if (args.sort !== undefined) {
    // 校验阶段允许逗号后带空格；发送前规范化，避免把空格传给 API。
    query.sort = args.sort
      .split(',')
      .map((group) => group.trim())
      .join(',');
  }
  if (args.archive !== undefined) query.archive = args.archive;
  if (args.query_type !== undefined) query.query_type = args.query_type;

  return query;
}

/* -------------------------------------------------------------------------- */
/* 结果包装                                                                    */
/* -------------------------------------------------------------------------- */

export function textResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}

export function errorResult(errorCode, errorMsg, extra = {}) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { error_code: errorCode, error_msg: errorMsg, ...extra },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function invalidArgumentsResult(details) {
  const first =
    Array.isArray(details) && details.length > 0
      ? `：${details[0]}`
      : '';
  return errorResult(
    ERROR_CODES.INVALID_ARGUMENTS,
    `参数校验失败${first}`,
    { details }
  );
}

function missingConfigResult(config) {
  const parts = [];
  if (config.missing.length > 0) {
    parts.push(`缺少环境变量 ${config.missing.join('、')}`);
  }
  if (config.invalid.length > 0) {
    parts.push(
      config.invalid
        .map((item) => `${item.name} 无效（${item.reason}）`)
        .join('；')
    );
  }

  const extra = { missing: config.missing };
  if (config.invalid.length > 0) extra.invalid = config.invalid;

  return errorResult(
    ERROR_CODES.MISSING_CONFIG,
    `配置缺失或无效：${parts.join('；')}`,
    extra
  );
}

function networkErrorResult(detail) {
  return errorResult(
    ERROR_CODES.NETWORK_ERROR,
    '请求 CodeArts Req API 时发生网络异常，请检查网络、终端节点与代理设置',
    { detail }
  );
}

function invalidResponseResult(httpStatus, detail) {
  return errorResult(
    ERROR_CODES.API_ERROR,
    `CodeArts Req API 响应格式不符合预期：${detail}`,
    { http_status: httpStatus }
  );
}

function safeJsonParse(text) {
  if (typeof text !== 'string') return undefined;
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (cleaned === '') return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function extractApiError(body, text, httpStatus) {
  const nested =
    isPlainObject(body) && isPlainObject(body.error) ? body.error : {};

  const code = pickFirstString(
    isPlainObject(body) ? body.error_code : undefined,
    isPlainObject(body) ? body.errorCode : undefined,
    nested.error_code,
    nested.code
  );

  let message = pickFirstString(
    isPlainObject(body) ? body.error_msg : undefined,
    isPlainObject(body) ? body.errorMsg : undefined,
    nested.error_msg,
    nested.message,
    isPlainObject(body) ? body.message : undefined
  );

  if (!message) {
    const plainText =
      typeof text === 'string' ? text.trim() : '';
    if (
      plainText !== '' &&
      plainText.length <= 500 &&
      !plainText.startsWith('<')
    ) {
      message = plainText;
    }
  }

  return {
    error_code: code || ERROR_CODES.API_ERROR,
    error_msg:
      message ||
      `CodeArts Req API 请求失败（HTTP ${httpStatus}）`,
  };
}

async function readResponseText(response) {
  if (!response) return '';
  if (typeof response.text === 'function') {
    const text = await response.text();
    return typeof text === 'string' ? text : String(text ?? '');
  }
  if (typeof response.json === 'function') {
    const json = await response.json();
    return JSON.stringify(json ?? null);
  }
  return '';
}

/**
 * 调用 CodeArts Req API。
 * 返回值不抛异常：{ kind: 'success' | 'api' | 'network' | 'protocol' }。
 */
export async function callCodeArtsApi({
  config,
  method,
  apiPath,
  query = null,
  body = undefined,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  let endpoint;
  try {
    endpoint = normalizeEndpoint(config.endpoint);
  } catch (error) {
    return {
      kind: 'network',
      detail: `终端节点配置无效：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (typeof fetchImpl !== 'function') {
    return { kind: 'network', detail: '当前运行环境没有可用的 fetch 实现' };
  }

  const requestPath = `${endpoint.basePath}${apiPath}`;
  const queryString = canonicalQueryString(query);
  const url =
    endpoint.origin + requestPath + (queryString ? `?${queryString}` : '');
  const payload =
    body === undefined || body === null ? '' : JSON.stringify(body);

  const signedHeaders = buildSignedHeaders({
    method,
    path: requestPath,
    query,
    body: payload,
    ak: config.ak,
    sk: config.sk,
    host: endpoint.host,
    now,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method,
      headers: signedHeaders,
      body: method === 'POST' ? payload : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });

    const text = await readResponseText(response);
    const httpStatus = Number(response?.status);

    if (httpStatus >= 200 && httpStatus < 300) {
      const parsed = safeJsonParse(text);
      if (!isPlainObject(parsed)) {
        return {
          kind: 'protocol',
          httpStatus,
          detail: '响应体不是合法的 JSON 对象',
        };
      }
      return { kind: 'success', httpStatus, data: parsed };
    }

    const parsed = safeJsonParse(text);
    return {
      kind: 'api',
      httpStatus,
      ...extractApiError(parsed, text, httpStatus),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return {
        kind: 'network',
        detail: `请求超时（${timeoutMs} ms）`,
      };
    }
    return {
      kind: 'network',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* -------------------------------------------------------------------------- */
/* 工具实现                                                                    */
/* -------------------------------------------------------------------------- */

export async function handleCreateProject(args, deps = {}) {
  const normalized = normalizeArguments(args);
  if (normalized === null) {
    return invalidArgumentsResult(['arguments 必须为 JSON 对象']);
  }

  const errors = validateCreateProject(normalized);
  if (errors.length > 0) return invalidArgumentsResult(errors);

  const config = getConfig(deps.env ?? process.env);
  if (config.missing.length > 0 || config.invalid.length > 0) {
    return missingConfigResult(config);
  }

  const result = await callCodeArtsApi({
    config,
    method: 'POST',
    apiPath: CREATE_PROJECT_PATH,
    body: buildCreateProjectBody(normalized),
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    timeoutMs: deps.timeoutMs,
  });

  if (result.kind === 'network') return networkErrorResult(result.detail);
  if (result.kind === 'protocol') {
    return invalidResponseResult(result.httpStatus, result.detail);
  }
  if (result.kind === 'api') {
    return errorResult(result.error_code, result.error_msg, {
      http_status: result.httpStatus,
    });
  }

  const data = result.data;
  if (typeof data.project_id !== 'string' || data.project_id === '') {
    return invalidResponseResult(
      result.httpStatus,
      '缺少 project_id 字段'
    );
  }

  const project = {};
  for (const field of [
    'project_id',
    'project_num_id',
    'project_name',
    'project_type',
    'user_num_id',
  ]) {
    if (data[field] !== undefined) project[field] = data[field];
  }
  return textResult(project);
}

export async function handleListProjects(args, deps = {}) {
  const normalized = normalizeArguments(args);
  if (normalized === null) {
    return invalidArgumentsResult(['arguments 必须为 JSON 对象']);
  }

  const errors = validateListProjects(normalized);
  if (errors.length > 0) return invalidArgumentsResult(errors);

  const config = getConfig(deps.env ?? process.env);
  if (config.missing.length > 0 || config.invalid.length > 0) {
    return missingConfigResult(config);
  }

  const result = await callCodeArtsApi({
    config,
    method: 'GET',
    apiPath: LIST_PROJECTS_PATH,
    query: buildListProjectsQuery(normalized),
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    timeoutMs: deps.timeoutMs,
  });

  if (result.kind === 'network') return networkErrorResult(result.detail);
  if (result.kind === 'protocol') {
    return invalidResponseResult(result.httpStatus, result.detail);
  }
  if (result.kind === 'api') {
    return errorResult(result.error_code, result.error_msg, {
      http_status: result.httpStatus,
    });
  }

  const { projects, total } = result.data;
  if (!Array.isArray(projects) || typeof total !== 'number') {
    return invalidResponseResult(
      result.httpStatus,
      'projects 须为数组且 total 须为数字'
    );
  }

  return textResult({ projects, total });
}

/* -------------------------------------------------------------------------- */
/* MCP Server                                                                  */
/* -------------------------------------------------------------------------- */

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'create_project',
    description:
      '创建华为云 CodeArts 需求项目（POST /v4/project）。返回 project_id、project_num_id、project_name、project_type、user_num_id。',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: '项目名称，必填，1-128 字符',
        },
        project_type: {
          type: 'string',
          enum: [...CREATE_PROJECT_TYPES],
          description:
            '项目类型，必填：scrum/normal/xboard/basic/phoenix/ipd',
        },
        description: {
          type: 'string',
          description: '项目描述，选填',
        },
        enterprise_id: {
          type: 'string',
          description: '企业项目 ID，选填',
        },
        source: {
          type: 'string',
          minLength: 0,
          maxLength: 64,
          description: '项目来源，选填，0-64 字符',
        },
        template_id: {
          type: 'integer',
          enum: [...TEMPLATE_IDS],
          description:
            '项目模板 ID，选填：10001/10002/10003；project_type=ipd 时必传',
        },
      },
      required: ['project_name', 'project_type'],
    },
  },
  {
    name: 'list_projects',
    description:
      '查询华为云 CodeArts 需求项目列表（GET /v4/projects）。返回 projects 数组与 total。',
    inputSchema: {
      type: 'object',
      properties: {
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
          default: 0,
          description: '偏移量，选填，默认 0，0-10000，且须为 limit 的整数倍',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 10,
          description: '每页数量，选填，默认 10，1-1000',
        },
        search: {
          type: 'string',
          description: '按项目名称或描述模糊搜索，选填',
        },
        project_type: {
          type: 'string',
          enum: [...LIST_PROJECT_TYPES],
          description: '项目类型，选填：scrum/normal/xboard',
        },
        sort: {
          type: 'string',
          description:
            '排序，格式为 字段:方向（如 name:asc），最多 4 组，逗号分隔',
        },
        archive: {
          type: 'boolean',
          description: '是否归档，选填',
        },
        query_type: {
          type: 'string',
          enum: [...QUERY_TYPES],
          description: '查询类型，选填：domain_projects/absent',
        },
      },
    },
  },
]);

export function createServer() {
  const server = new Server(
    { name: SERVICE_NAME, version: SERVICE_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request?.params?.name;
    const args = request?.params?.arguments;

    try {
      if (name === 'create_project') return await handleCreateProject(args);
      if (name === 'list_projects') return await handleListProjects(args);

      return errorResult(
        ERROR_CODES.INVALID_ARGUMENTS,
        `未知工具：${name ?? '(空)'}`
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[${SERVICE_NAME}] 工具 ${String(name)} 执行异常：${detail}\n`
      );
      return errorResult(
        ERROR_CODES.INTERNAL_ERROR,
        '处理工具调用时发生内部错误',
        { detail }
      );
    }
  });

  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // realpath 同时处理 Unix 安装后 node_modules/.bin 的符号链接。
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(path.resolve(process.argv[1]));
    if (process.platform === 'win32') {
      return modulePath.toLowerCase() === invokedPath.toLowerCase();
    }
    return modulePath === invokedPath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    const detail =
      error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[${SERVICE_NAME}] MCP Server 启动失败：${detail}\n`
    );
    process.exitCode = 1;
  });
}
