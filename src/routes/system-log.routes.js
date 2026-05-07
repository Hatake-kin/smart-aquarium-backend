const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "demo_secret_key";

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Thiếu token đăng nhập" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Token không hợp lệ" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token hết hạn hoặc không hợp lệ" });
  }
}

function managerOnly(req, res, next) {
  if (req.user.role !== "admin" && req.user.role !== "moderator") {
    return res.status(403).json({
      message: "Chỉ admin hoặc moderator được xem nhật ký hệ thống",
    });
  }

  next();
}

// ===============================
// LẤY NHẬT KÝ HỆ THỐNG
// ===============================
router.get("/", authMiddleware, managerOnly, async (req, res) => {
  try {
    const action = req.query.action || "";
    const entityType = req.query.entity_type || "";
    const userId = req.query.user_id ? Number(req.query.user_id) : null;
    const limit = Math.min(Number(req.query.limit || 100), 300);

    const conditions = [];
    const params = [];

    if (action) {
      conditions.push("sl.action = ?");
      params.push(action);
    }

    if (entityType) {
      conditions.push("sl.entity_type = ?");
      params.push(entityType);
    }

    if (userId) {
      conditions.push("sl.user_id = ?");
      params.push(userId);
    }

    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await db.query(
      `SELECT
        sl.id,
        sl.user_id,
        sl.action,
        sl.entity_type,
        sl.entity_id,
        sl.description,
        sl.ip_address,
        sl.user_agent,
        sl.created_at,
        u.email,
        u.full_name,
        u.role
       FROM system_logs sl
       LEFT JOIN users u ON sl.user_id = u.id
       ${whereSql}
       ORDER BY sl.id DESC
       LIMIT ?`,
      [...params, limit]
    );

    res.json({
      message: "Lấy nhật ký hệ thống thành công",
      logs: rows,
    });
  } catch (err) {
    console.error("Get system logs error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy nhật ký hệ thống",
    });
  }
});

// ===============================
// THỐNG KÊ NHẬT KÝ
// ===============================
router.get("/summary/counts", authMiddleware, managerOnly, async (req, res) => {
  try {
    const [totalRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM system_logs`
    );

    const [actionRows] = await db.query(
      `SELECT action, COUNT(*) AS total
       FROM system_logs
       GROUP BY action
       ORDER BY total DESC
       LIMIT 20`
    );

    const [entityRows] = await db.query(
      `SELECT entity_type, COUNT(*) AS total
       FROM system_logs
       WHERE entity_type IS NOT NULL
       GROUP BY entity_type
       ORDER BY total DESC`
    );

    res.json({
      message: "Lấy thống kê nhật ký thành công",
      summary: {
        total: totalRows[0].total,
        actions: actionRows,
        entities: entityRows,
      },
    });
  } catch (err) {
    console.error("Get system log summary error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy thống kê nhật ký",
    });
  }
});

module.exports = router;
