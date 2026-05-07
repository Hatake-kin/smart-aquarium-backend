const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const {
  createSystemLog,
  getRequestInfo,
} = require("../services/log.service");

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

function isAdmin(role) {
  return role === "admin";
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

async function getDeviceWithOwner(deviceId, reqUser) {
  let rows;

  if (isManager(reqUser.role)) {
    [rows] = await db.query(
      `SELECT
        d.id,
        d.tank_id,
        d.device_code,
        d.name,
        d.status AS device_status,
        d.camera_url,
        t.name AS tank_name,
        t.tank_code,
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
        d.id,
        d.tank_id,
        d.device_code,
        d.name,
        d.status AS device_status,
        d.camera_url,
        t.name AS tank_name,
        t.tank_code,
        t.status AS tank_status,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        u.plan_type,
        u.plan_expires_at
       FROM devices d
       LEFT JOIN tanks t ON d.tank_id = t.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE d.id = ? AND u.id = ?`,
      [deviceId, reqUser.id]
    );
  }

  if (rows.length === 0) return null;

  const device = rows[0];
  const plan = getEffectivePlanFromUser(device);

  return {
    ...device,
    effective_plan: isManager(reqUser.role) ? "manager" : plan.effective_plan,
    is_premium_expired: isManager(reqUser.role)
      ? false
      : plan.is_premium_expired,
    can_use_camera: isManager(reqUser.role) || plan.effective_plan === "premium",
  };
}

// ===============================
// LẤY DANH SÁCH CAMERA
// ===============================
router.get("/", authMiddleware, async (req, res) => {
  try {
    let rows;

    if (isManager(req.user.role)) {
      [rows] = await db.query(
        `SELECT
          d.id,
          d.tank_id,
          d.device_code,
          d.name,
          d.status AS device_status,
          d.camera_url,
          t.name AS tank_name,
          t.tank_code,
          t.status AS tank_status,
          u.id AS owner_id,
          u.email AS owner_email,
          u.full_name AS owner_full_name,
          u.plan_type,
          u.plan_expires_at
         FROM devices d
         LEFT JOIN tanks t ON d.tank_id = t.id
         LEFT JOIN users u ON t.user_id = u.id
         ORDER BY d.id DESC`
      );
    } else {
      [rows] = await db.query(
        `SELECT
          d.id,
          d.tank_id,
          d.device_code,
          d.name,
          d.status AS device_status,
          d.camera_url,
          t.name AS tank_name,
          t.tank_code,
          t.status AS tank_status,
          u.id AS owner_id,
          u.email AS owner_email,
          u.full_name AS owner_full_name,
          u.plan_type,
          u.plan_expires_at
         FROM devices d
         LEFT JOIN tanks t ON d.tank_id = t.id
         LEFT JOIN users u ON t.user_id = u.id
         WHERE u.id = ?
         ORDER BY d.id DESC`,
        [req.user.id]
      );
    }

    const devices = rows.map((device) => {
      const plan = getEffectivePlanFromUser(device);

      return {
        ...device,
        effective_plan: isManager(req.user.role)
          ? "manager"
          : plan.effective_plan,
        is_premium_expired: isManager(req.user.role)
          ? false
          : plan.is_premium_expired,
        can_use_camera:
          isManager(req.user.role) || plan.effective_plan === "premium",
      };
    });

    res.json({
      message: "Lấy danh sách camera thành công",
      devices,
    });
  } catch (err) {
    console.error("Get camera list error:", err);
    res.status(500).json({ message: "Lỗi server khi lấy danh sách camera" });
  }
});

// ===============================
// XEM CAMERA 1 THIẾT BỊ
// ===============================
router.get("/devices/:id", authMiddleware, async (req, res) => {
  try {
    const deviceId = Number(req.params.id);

    if (!deviceId) {
      return res.status(400).json({ message: "Thiếu device_id" });
    }

    const device = await getDeviceWithOwner(deviceId, req.user);

    if (!device) {
      return res.status(404).json({
        message:
          "Không tìm thấy thiết bị hoặc bạn không có quyền xem thiết bị này",
      });
    }

    if (!device.can_use_camera) {
      return res.status(403).json({
        message: device.is_premium_expired
          ? "Gói Premium đã hết hạn. Tính năng camera đã bị khóa. Vui lòng liên hệ admin để gia hạn."
          : "Tính năng camera chỉ dành cho gói Premium.",
        device,
      });
    }

    if (!device.camera_url) {
      return res.status(404).json({
        message: "Thiết bị này chưa được cấu hình camera_url",
        device,
      });
    }

    res.json({
      message: "Lấy camera thành công",
      device,
      camera_url: device.camera_url,
    });
  } catch (err) {
    console.error("Get camera device error:", err);
    res.status(500).json({ message: "Lỗi server khi lấy camera" });
  }
});

// ===============================
// CẬP NHẬT CAMERA URL
// Admin cập nhật mọi thiết bị
// User Premium còn hạn cập nhật thiết bị của mình
// Moderator không được cập nhật
// ===============================
router.patch("/devices/:id", authMiddleware, async (req, res) => {
  try {
    const requestInfo = getRequestInfo(req);
    const deviceId = Number(req.params.id);
    const { camera_url } = req.body;

    if (!deviceId) {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_camera_url_failed_missing_device_id",
        entity_type: "device",
        entity_id: null,
        description: `Người dùng ${req.user.email} cập nhật camera_url thất bại: thiếu device_id`,
        ...requestInfo,
      });

      return res.status(400).json({ message: "Thiếu device_id" });
    }

    if (req.user.role === "moderator") {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_camera_url_failed_no_permission",
        entity_type: "device",
        entity_id: deviceId,
        description: `Moderator ${req.user.email} bị chặn cập nhật camera_url cho thiết bị ID ${deviceId}`,
        ...requestInfo,
      });

      return res.status(403).json({
        message:
          "Moderator chỉ được xem camera, không được cập nhật camera_url",
      });
    }

    if (camera_url && !/^https?:\/\//i.test(camera_url)) {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_camera_url_failed_invalid_url",
        entity_type: "device",
        entity_id: deviceId,
        description: `Người dùng ${req.user.email} cập nhật camera_url thất bại cho thiết bị ID ${deviceId}: URL không hợp lệ`,
        ...requestInfo,
      });

      return res.status(400).json({
        message: "camera_url phải bắt đầu bằng http:// hoặc https://",
      });
    }

    const device = await getDeviceWithOwner(deviceId, req.user);

    if (!device) {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_camera_url_failed_device_not_found",
        entity_type: "device",
        entity_id: deviceId,
        description: `Người dùng ${req.user.email} cập nhật camera_url thất bại: không tìm thấy thiết bị ID ${deviceId} hoặc không có quyền`,
        ...requestInfo,
      });

      return res.status(404).json({
        message: "Không tìm thấy thiết bị hoặc bạn không có quyền cập nhật",
      });
    }

    if (!isAdmin(req.user.role) && !device.can_use_camera) {
      await createSystemLog({
        user_id: req.user.id,
        action: device.is_premium_expired
          ? "update_camera_url_failed_premium_expired"
          : "update_camera_url_failed_premium_required",
        entity_type: "device",
        entity_id: deviceId,
        description: device.is_premium_expired
          ? `Người dùng ${req.user.email} cập nhật camera_url thất bại cho thiết bị ${device.device_code}: Premium đã hết hạn`
          : `Người dùng ${req.user.email} cập nhật camera_url thất bại cho thiết bị ${device.device_code}: cần gói Premium`,
        ...requestInfo,
      });

      return res.status(403).json({
        message: device.is_premium_expired
          ? "Gói Premium đã hết hạn. Không thể cập nhật camera_url."
          : "Chỉ tài khoản Premium mới được cấu hình camera.",
      });
    }

    const oldCameraUrl = device.camera_url || null;
    const finalCameraUrl = camera_url || null;

    await db.query("UPDATE devices SET camera_url = ? WHERE id = ?", [
      finalCameraUrl,
      deviceId,
    ]);

    await createSystemLog({
      user_id: req.user.id,
      action: finalCameraUrl
        ? "update_camera_url_success"
        : "clear_camera_url_success",
      entity_type: "device",
      entity_id: deviceId,
      description: finalCameraUrl
        ? `Người dùng ${req.user.email} cập nhật camera_url cho thiết bị ${device.device_code}. URL cũ: ${
            oldCameraUrl || "chưa có"
          }. URL mới: ${finalCameraUrl}`
        : `Người dùng ${req.user.email} đã xóa camera_url của thiết bị ${device.device_code}. URL cũ: ${
            oldCameraUrl || "chưa có"
          }`,
      ...requestInfo,
    });

    res.json({
      message: finalCameraUrl
        ? "Cập nhật camera_url thành công"
        : "Đã xóa camera_url",
      device_id: deviceId,
      camera_url: finalCameraUrl,
    });
  } catch (err) {
    console.error("Update camera URL error:", err);
    res.status(500).json({ message: "Lỗi server khi cập nhật camera_url" });
  }
});

module.exports = router;