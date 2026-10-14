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

// multer:文件暂存内存(演示场景文件小);限制单文件 10MB 防误传。
// defParamCharset:浏览器以 UTF-8 发送 filename,而 busboy 默认按 latin1
// 解码会导致中文文件名乱码,这里显式指定 utf8 修正。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  defParamCharset: 'utf8',
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
 * 可选查询参数 filename:提供时设置 Content-Disposition(浏览器按该文件名
 * 展示/下载);.json 结尾时以 application/json 返回,浏览器直接文本展示。
 */
router.get(
  '/ipfs/:cid',
  requireRole('operator', 'checker', 'auditor', 'regulator'),
  async (req, res) => {
    try {
      const content = await ipfs.download(req.params.cid);
      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      if (filename) {
        const isJson = filename.toLowerCase().endsWith('.json');
        res.setHeader(
          'Content-Type',
          isJson ? 'application/json; charset=utf-8' : 'application/octet-stream'
        );
        // inline:浏览器优先直接展示;filename*=UTF-8'' 支持中文文件名
        res.setHeader(
          'Content-Disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
      } else {
        res.setHeader('Content-Type', 'application/octet-stream');
      }
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
