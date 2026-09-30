// =============================================================================
// 上传与 IPFS 路由:
//   POST /api/upload —— 上传文件到 IPFS,返回 { cid, sha256, size, name }
//   GET  /api/ipfs/:cid —— 按 CID 取回文件(核对预览、消费者验证页使用)
//
// 上传后得到 CID 与 SHA-256,再调用 POST /api/batches 锚定上链。
// 仅业务方角色(operator/checker)允许上传;regulator 只读。
// =============================================================================

import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import * as ipfs from '../services/ipfs.js';
import { requireRole } from '../middleware/role.js';

const router = Router();

// multer:文件暂存内存(演示场景文件小);限制单文件 10MB 防误传
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * POST /api/upload —— multipart 表单上传,字段名 file。
 * 返回:{ cid, sha256, size, name },其中 sha256 供链上锚定与后续核验。
 */
router.post(
  '/upload',
  requireRole('operator', 'checker'),
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: '缺少上传文件,表单字段名须为 file' });
      }
      const content = req.file.buffer;
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const { cid, size } = await ipfs.upload(content, req.file.originalname || 'file');
      return res.json({
        ok: true,
        data: { cid, sha256, size, name: req.file.originalname },
      });
    } catch (err) {
      return res.status(502).json({
        ok: false,
        error: `IPFS 上传失败(请确认 Kubo 节点已启动、IPFS_API_URL 正确): ${err?.message ?? err}`,
      });
    }
  }
);

/**
 * GET /api/ipfs/:cid —— 按 CID 从 IPFS 取回文件内容。
 * 任意角色可用(核对人预览、消费者核验文件)。
 */
router.get(
  '/ipfs/:cid',
  requireRole('operator', 'checker', 'auditor', 'regulator'),
  async (req, res) => {
    try {
      const content = await ipfs.download(req.params.cid);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(content.length));
      return res.send(content);
    } catch (err) {
      return res.status(502).json({
        ok: false,
        error: `IPFS 读取失败(CID: ${req.params.cid}): ${err?.message ?? err}`,
      });
    }
  }
);

export default router;
