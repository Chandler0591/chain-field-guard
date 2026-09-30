// =============================================================================
// 角色中间件单元测试 —— 无需网络/链码,任何时候都能跑:
//   cd backend && npm test
//
// 验证点:
//   1. resolveRole 的角色来源优先级:query > header > body,缺省 operator;
//   2. requireRole 白名单:允许的角色放行并挂到 req.role;
//   3. 白名单外的合法角色 → 403(如监管方尝试写操作);
//   4. 未知角色 → 400。
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole, requireRole } from '../../src/middleware/role.js';

// ---- 构造最小化的 req/res 模拟对象(中间件只用到这几处) ----

function mockReq({ query = {}, headers = {}, body = {} } = {}) {
  return { query, headers, body };
}

function mockRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

/** 执行中间件,返回 { req, res, nextCalled } */
function run(middleware, req) {
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

// ---- resolveRole:角色来源与优先级 ----

test('resolveRole: 都未提供时默认 operator(演示便捷)', () => {
  assert.equal(resolveRole(mockReq()), 'operator');
});

test('resolveRole: 优先级 query > header > body', () => {
  const req = mockReq({
    query: { role: 'auditor' },
    headers: { 'x-role': 'checker' },
    body: { role: 'operator' },
  });
  assert.equal(resolveRole(req), 'auditor');
});

test('resolveRole: 无 query 时取 header,无 header 时取 body', () => {
  assert.equal(resolveRole(mockReq({ headers: { 'x-role': 'regulator' } })), 'regulator');
  assert.equal(resolveRole(mockReq({ body: { role: 'checker' } })), 'checker');
});

// ---- requireRole:白名单与拦截 ----

test('requireRole: 允许的角色放行并写入 req.role', () => {
  const req = mockReq({ query: { role: 'auditor' } });
  const { res, nextCalled } = run(requireRole('auditor'), req);
  assert.equal(nextCalled, true);
  assert.equal(req.role, 'auditor');
  assert.equal(res.statusCode, null);
});

test('requireRole: 白名单外的合法角色返回 403(如监管方调用写接口)', () => {
  // 模拟 regulator 试图调用仅 operator 可用的锚定接口
  const req = mockReq({ query: { role: 'regulator' } });
  const { res, nextCalled } = run(requireRole('operator'), req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.error, /regulator.*无权|无权.*regulator/);
});

test('requireRole: 多角色白名单(修改请求允许 operator/checker)', () => {
  for (const role of ['operator', 'checker']) {
    const req = mockReq({ query: { role } });
    const { res, nextCalled } = run(requireRole('operator', 'checker'), req);
    assert.equal(nextCalled, true, `角色 ${role} 应被放行`);
    assert.equal(res.statusCode, null);
  }
});

test('requireRole: 未知角色返回 400', () => {
  const req = mockReq({ query: { role: 'hacker' } });
  const { res, nextCalled } = run(requireRole('operator', 'auditor'), req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /未知角色/);
});

test('requireRole: 读接口对全部四个角色放行(含监管方)', () => {
  for (const role of ['operator', 'checker', 'auditor', 'regulator']) {
    const req = mockReq({ query: { role } });
    const { nextCalled } = run(
      requireRole('operator', 'checker', 'auditor', 'regulator'),
      req
    );
    assert.equal(nextCalled, true, `角色 ${role} 应可查询`);
  }
});
