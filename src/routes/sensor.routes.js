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

function getEffectivePlanFromUser(user) {
  const isPremium = user.plan_type === "premium";

  const isExpired =
    isPremium &&
    user.plan_expires_at &&
    new Date(user.plan_expires_at).getTime() < Date.now();

  const isPremiumActive = isPremium && !isExpired;

  return {
    effective_plan: isPremiumActive ? "premium" : "basic",
    is_premium_active: isPremiumActive,
    is_premium_expired: Boolean(isExpired),
  };
}

// Lấy thông tin thiết bị + chủ sở hữu để kiểm tra quyền và gói
async function getDeviceInfo(deviceId, reqUser) {
  let rows;

  if (isManager(reqUser.role)) {
    [rows] = await db.query(
      `SELECT 
        d.id AS device_id,
        d.device_code,
        d.name AS device_name,
        d.status AS device_status,
        t.id AS tank_id,
        t.name AS tank_name,
        t.status AS tank_status,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        u.plan_type,
        u.plan_expires_at
       FROM devices d
       LEFT JOIN tanks t ON d.tank_id = t.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE d.id = ?`,
      [deviceId]
    );
  } else {
    [rows] = await db.query(
      `SELECT 
        d.id AS device_id,
        d.device_code,
        d.name AS device_name,
        d.status AS device_status,
        t.id AS tank_id,
        t.name AS tank_name,
        t.status AS tank_status,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        u.plan_type,
        u.plan_expires_at
       FROM devices d
       LEFT JOIN tanks t ON d.tank_id = t.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE d.id = ? AND t.user_id = ?`,
      [deviceId, reqUser.id]
    );
  }

  if (rows.length === 0) {
    return null;
  }

  return rows[0];
}

// Lấy limit lịch sử theo gói
function getHistoryLimit(deviceInfo, reqUser) {
  if (isManager(reqUser.role)) {
    return {
      limit: 100,
      effective_plan: "manager",
      is_premium_expired: false,
    };
  }

  const plan = getEffectivePlanFromUser(deviceInfo);

  return {
    limit: plan.effective_plan === "premium" ? 100 : 20,
    effective_plan: plan.effective_plan,
    is_premium_expired: plan.is_premium_expired,
  };
}

// ===============================
// LẤY DỮ LIỆU CẢM BIẾN MỚI NHẤT
// ===============================
router.get("/latest", authMiddleware, async (req, res) => {
  try {
    const deviceId = Number(req.query.device_id);

    if (!deviceId) {
      return res.status(400).json({ message: "Thiếu device_id" });
    }

    const deviceInfo = await getDeviceInfo(deviceId, req.user);

    if (!deviceInfo) {
      return res.status(404).json({
        message: "Không tìm thấy thiết bị hoặc bạn không có quyền xem thiết bị này",
      });
    }

    const [sensorRows] = await db.query(
      `SELECT *
       FROM sensor_data
       WHERE device_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [deviceId]
    );

    res.json({
      message: "Lấy dữ liệu cảm biến mới nhất thành công",
      device: deviceInfo,
      data: sensorRows[0] || null,
    });
  } catch (err) {
    console.error("Get latest sensor error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy dữ liệu cảm biến mới nhất",
    });
  }
});

// ===============================
// LẤY LỊCH SỬ DỮ LIỆU CẢM BIẾN
// ===============================
router.get("/history", authMiddleware, async (req, res) => {
  try {
    const deviceId = Number(req.query.device_id);

    if (!deviceId) {
      return res.status(400).json({ message: "Thiếu device_id" });
    }

    const deviceInfo = await getDeviceInfo(deviceId, req.user);

    if (!deviceInfo) {
      return res.status(404).json({
        message: "Không tìm thấy thiết bị hoặc bạn không có quyền xem thiết bị này",
      });
    }

    const planLimit = getHistoryLimit(deviceInfo, req.user);

    const [rows] = await db.query(
      `SELECT *
       FROM sensor_data
       WHERE device_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [deviceId, planLimit.limit]
    );

    res.json({
      message: "Lấy lịch sử dữ liệu cảm biến thành công",
      limit: planLimit.limit,
      effective_plan: planLimit.effective_plan,
      is_premium_expired: planLimit.is_premium_expired,
      device: deviceInfo,
      data: rows.reverse(),
    });
  } catch (err) {
    console.error("Get sensor history error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy lịch sử dữ liệu cảm biến",
    });
  }
});

module.exports = router;