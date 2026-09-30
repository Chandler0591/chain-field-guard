// =============================================================================
// 角色中间件:解析请求携带的角色,并校验其是否允许执行当前接口。
//
// 角色传递方式(演示场景,便于前端角色切换面板直接调用):
//   1. URL 查询参数:?role=operator
//   2. 请求头:X-Role: operator
//   3. JSON 请求体:{ role: 'operator' }
// 优先级:query > header > body;都不传时默认 operator。
//
// 安全说明:本中间件只是"选择用哪个身份提交交易"的开关,真正的权限
// 校验在链码内(证书 role 属性 + Org2 只读),即使有人伪造 role 参数,
// 也拿不到对应身份的私钥,只能以自己钱包里的身份上链。
// =============================================================================

// 全部合法角色(与 network/registerEnroll.sh 注册的身份一致)
export const ALL_ROLES = ['operator', 'checker', 'auditor', 'regulator'];

/**
 * 从请求中解析角色名(纯函数,便于单元测试)。
 * @param {{query?:any, headers?:any, body?:any}} req Express 风格请求对象
 * @returns {string} 角色名,缺省为 operator
 */
export function resolveRole(req) {
  const fromQuery = req?.query?.role;
  const fromHeader = req?.headers?.['x-role'];
  const fromBody = req?.body?.role;
  return fromQuery || fromHeader || fromBody || 'operator';
}

/**
 * 生成"角色白名单"中间件:
 *   1. 未知角色 → 400;
 *   2. 角色不在白名单 → 403;
 *   3. 通过后把角色挂到 req.role 供路由使用。
 * @param {...string} allowed 允许执行本接口的角色列表
 */
export function requireRole(...allowed) {
  return (req, res, next) => {
    const role = resolveRole(req);
    if (!ALL_ROLES.includes(role)) {
      return res.status(400).json({
        ok: false,
        error: `未知角色 "${role}",可选角色: ${ALL_ROLES.join(' / ')}`,
      });
    }
    if (!allowed.includes(role)) {
      return res.status(403).json({
        ok: false,
        error: `角色 "${role}" 无权执行此操作,允许角色: ${allowed.join(' / ')}`,
      });
    }
    req.role = role;
    return next();
  };
}
