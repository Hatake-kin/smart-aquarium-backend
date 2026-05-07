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

function isManager(role) {
  return role === "admin" || role === "moderator";
}

async function getAlertWithPermission(alertId, reqUser) {
  let rows;

  if (isManager(reqUser.role)) {
    [rows] = await db.query(
      `SELECT
        a.*,
        t.name AS tank_name,
        t.tank_code,
        d.device_code,
        d.name AS device_name,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name
       FROM alerts a
       LEFT JOIN tanks t ON a.tank_id = t.id
       LEFT JOIN devices d ON a.device_id = d.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE a.id = ?`,
      [alertId]
    );
  } else {
    [rows] = await db.query(
      `SELECT
        a.*,
        t.name AS tank_name,
        t.tank_code,
        d.device_code,
        d.name AS device_name,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name
       FROM alerts a
       LEFT JOIN tanks t ON a.tank_id = t.id
       LEFT JOIN devices d ON a.device_id = d.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE a.id = ? AND t.user_id = ?`,
      [alertId, reqUser.id]
    );
  }

  return rows[0] || null;
}

// ===============================
// LẤY LỊCH SỬ CẢNH BÁO
// Admin/Moderator: xem tất cả
// User: chỉ xem cảnh báo bể của mình
// ===============================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const status = req.query.status || "";
    const severity = req.query.severity || "";
    const limit = Math.min(Number(req.query.limit || 100), 300);

    const conditions = [];
    const params = [];

    if (!isManager(req.user.role)) {
      conditions.push("t.user_id = ?");
      params.push(req.user.id);
    }

    if (status && ["new", "resolved"].includes(status)) {
      conditions.push("a.status = ?");
      params.push(status);
    }

    if (severity && ["low", "medium", "high"].includes(severity)) {
      conditions.push("a.severity = ?");
      params.push(severity);
    }

    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await db.query(
      `SELECT
        a.id,
        a.tank_id,
        a.device_id,
        a.message,
        a.alert_type,
        a.current_value,
        a.threshold_value,
        a.severity,
        a.is_read,
        a.status,
        a.resolved_at,
        a.resolved_by,
        a.created_at,
        a.updated_at,
        t.name AS tank_name,
        t.tank_code,
        d.device_code,
        d.name AS device_name,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        resolver.email AS resolved_by_email,
        resolver.full_name AS resolved_by_name
       FROM alerts a
       LEFT JOIN tanks t ON a.tank_id = t.id
       LEFT JOIN devices d ON a.device_id = d.id
       LEFT JOIN users u ON t.user_id = u.id
       LEFT JOIN users resolver ON a.resolved_by = resolver.id
       ${whereSql}
       ORDER BY a.id DESC
       LIMIT ?`,
      [...params, limit]
    );

    res.json({
      message: "Lấy lịch sử cảnh báo thành công",
      alerts: rows,
    });
  } catch (err) {
    console.error("Get alerts error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy lịch sử cảnh báo",
    });
  }
});

// ===============================
// ĐÁNH DẤU ĐÃ ĐỌC
// ===============================
router.patch("/:id/read", authMiddleware, async (req, res) => {
  try {
    const alertId = Number(req.params.id);

    if (!alertId) {
      return res.status(400).json({ message: "Thiếu alert_id" });
    }

    const alert = await getAlertWithPermission(alertId, req.user);

    if (!alert) {
      return res.status(404).json({
        message: "Không tìm thấy cảnh báo hoặc bạn không có quyền",
      });
    }

    await db.query("UPDATE alerts SET is_read = 1 WHERE id = ?", [alertId]);

    res.json({
      message: "Đã đánh dấu cảnh báo là đã đọc",
    });
  } catch (err) {
    console.error("Read alert error:", err);
    res.status(500).json({
      message: "Lỗi server khi đánh dấu đã đọc",
    });
  }
});

// ===============================
// ĐÁNH DẤU ĐÃ XỬ LÝ
// ===============================
router.patch("/:id/resolve", authMiddleware, async (req, res) => {
  try {
    const alertId = Number(req.params.id);

    if (!alertId) {
      return res.status(400).json({ message: "Thiếu alert_id" });
    }

    const alert = await getAlertWithPermission(alertId, req.user);

    if (!alert) {
      return res.status(404).json({
        message: "Không tìm thấy cảnh báo hoặc bạn không có quyền",
      });
    }

    await db.query(
      `UPDATE alerts
       SET status = 'resolved',
           is_read = 1,
           resolved_at = NOW(),
           resolved_by = ?
       WHERE id = ?`,
      [req.user.id, alertId]
    );

    res.json({
      message: "Đã đánh dấu cảnh báo là đã xử lý",
    });
  } catch (err) {
    console.error("Resolve alert error:", err);
    res.status(500).json({
      message: "Lỗi server khi xử lý cảnh báo",
    });
  }
});

// ===============================
// MỞ LẠI CẢNH BÁO
// ===============================
router.patch("/:id/reopen", authMiddleware, async (req, res) => {
  try {
    const alertId = Number(req.params.id);

    if (!alertId) {
      return res.status(400).json({ message: "Thiếu alert_id" });
    }

    const alert = await getAlertWithPermission(alertId, req.user);

    if (!alert) {
      return res.status(404).json({
        message: "Không tìm thấy cảnh báo hoặc bạn không có quyền",
      });
    }

    await db.query(
      `UPDATE alerts
       SET status = 'new',
           resolved_at = NULL,
           resolved_by = NULL
       WHERE id = ?`,
      [alertId]
    );

    res.json({
      message: "Đã mở lại cảnh báo",
    });
  } catch (err) {
    console.error("Reopen alert error:", err);
    res.status(500).json({
      message: "Lỗi server khi mở lại cảnh báo",
    });
  }
});

// ===============================
// THỐNG KÊ CẢNH BÁO
// ===============================
router.get("/summary/counts", authMiddleware, async (req, res) => {
  try {
    const conditions = [];
    const params = [];

    if (!isManager(req.user.role)) {
      conditions.push("t.user_id = ?");
      params.push(req.user.id);
    }

    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await db.query(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN a.status = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN a.status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
        SUM(CASE WHEN a.severity = 'high' THEN 1 ELSE 0 END) AS high_count,
        SUM(CASE WHEN a.severity = 'medium' THEN 1 ELSE 0 END) AS medium_count,
        SUM(CASE WHEN a.severity = 'low' THEN 1 ELSE 0 END) AS low_count
       FROM alerts a
       LEFT JOIN tanks t ON a.tank_id = t.id
       ${whereSql}`,
      params
    );

    res.json({
      message: "Lấy thống kê cảnh báo thành công",
      summary: rows[0],
    });
  } catch (err) {
    console.error("Alert summary error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy thống kê cảnh báo",
    });
  }
});

module.exports = router;