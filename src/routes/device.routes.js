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

function generateDeviceCode() {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `ESP32_${random}`;
}

// Tính gói thật sự đang có hiệu lực của user
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

// Lấy danh sách thiết bị
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
          d.hardware_version,
          d.firmware_version,
          d.last_seen,
          d.battery_level,
          d.rssi,
          d.status,
          d.camera_url,
          d.created_at,
          t.name AS tank_name,
          t.tank_code,
          t.status AS tank_status,
          u.id AS owner_id,
          u.email,
          u.full_name,
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
          d.hardware_version,
          d.firmware_version,
          d.last_seen,
          d.battery_level,
          d.rssi,
          d.status,
          d.camera_url,
          d.created_at,
          t.name AS tank_name,
          t.tank_code,
          t.status AS tank_status,
          u.id AS owner_id,
          u.plan_type,
          u.plan_expires_at
        FROM devices d
        LEFT JOIN tanks t ON d.tank_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.user_id = ?
        ORDER BY d.id DESC`,
        [req.user.id]
      );
    }

    // Tính rank thiết bị trong từng bể theo id tăng dần.
    // Basic chỉ xem 3 thiết bị đầu tiên là active theo gói.
    const rankMap = new Map();

    const sortedAsc = [...rows].sort((a, b) => {
      if (a.tank_id !== b.tank_id) return a.tank_id - b.tank_id;
      return a.id - b.id;
    });

    const counterByTank = {};

    for (const device of sortedAsc) {
      counterByTank[device.tank_id] = (counterByTank[device.tank_id] || 0) + 1;
      rankMap.set(device.id, counterByTank[device.tank_id]);
    }

    const devices = rows.map((device) => {
      const plan = getEffectivePlanFromUser(device);
      const rankInTank = rankMap.get(device.id) || 1;

      const overDeviceLimit =
        plan.effective_plan === "basic" && rankInTank > 3;

      const suspendedByTank = device.tank_status === "suspended";

      return {
        ...device,
        effective_plan: plan.effective_plan,
        is_premium_expired: plan.is_premium_expired,
        rank_in_tank: rankInTank,
        access_status:
          overDeviceLimit || suspendedByTank
            ? "suspended_by_plan"
            : device.status || "active",
      };
    });

    res.json({
      message: "Lấy danh sách thiết bị thành công",
      devices,
    });
  } catch (err) {
    console.error("Get devices error:", err);
    res.status(500).json({ message: "Lỗi server khi lấy danh sách thiết bị" });
  }
});

// Tạo thiết bị mới và gắn vào bể cá
router.post("/", authMiddleware, async (req, res) => {
  try {
    const requestInfo = getRequestInfo(req);

    const {
      tank_id,
      device_code,
      name,
      hardware_version,
      firmware_version,
      battery_level,
      rssi,
    } = req.body;

    if (!tank_id) {
      await createSystemLog({
        user_id: req.user.id,
        action: "create_device_failed_missing_tank_id",
        entity_type: "device",
        entity_id: null,
        description: `Người dùng ${req.user.email} tạo thiết bị thất bại: thiếu tank_id`,
        ...requestInfo,
      });

      return res.status(400).json({ message: "Thiếu tank_id" });
    }

    // Kiểm tra bể có tồn tại, chủ sở hữu là ai, và tài khoản đang dùng gói gì
    let tankRows;

    if (isManager(req.user.role)) {
      [tankRows] = await db.query(
        `SELECT 
          t.*,
          u.email AS owner_email,
          u.plan_type,
          u.plan_expires_at
        FROM tanks t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.id = ?`,
        [tank_id]
      );
    } else {
      [tankRows] = await db.query(
        `SELECT 
          t.*,
          u.email AS owner_email,
          u.plan_type,
          u.plan_expires_at
        FROM tanks t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.id = ? AND t.user_id = ?`,
        [tank_id, req.user.id]
      );
    }

    if (tankRows.length === 0) {
      await createSystemLog({
        user_id: req.user.id,
        action: "create_device_failed_tank_not_found",
        entity_type: "tank",
        entity_id: Number(tank_id) || null,
        description: `Người dùng ${req.user.email} tạo thiết bị thất bại: không tìm thấy bể ${tank_id} hoặc không có quyền`,
        ...requestInfo,
      });

      return res.status(404).json({
        message: "Không tìm thấy bể cá hoặc bạn không có quyền",
      });
    }

    const tank = tankRows[0];

    // User thường: kiểm tra giới hạn theo gói
    if (!isManager(req.user.role)) {
      const plan = getEffectivePlanFromUser(tank);

      // Nếu tank bị suspended thì không cho thêm thiết bị
      if (tank.status === "suspended") {
        await createSystemLog({
          user_id: req.user.id,
          action: "create_device_failed_tank_suspended",
          entity_type: "tank",
          entity_id: Number(tank_id),
          description: `Người dùng ${req.user.email} tạo thiết bị thất bại: bể "${tank.name}" đang bị tạm khóa`,
          ...requestInfo,
        });

        return res.status(403).json({
          message:
            "Bể cá này đang bị tạm khóa do gói Premium hết hạn hoặc do admin khóa. Không thể thêm thiết bị mới.",
        });
      }

      // Nếu tài khoản đang Basic hoặc Premium hết hạn
      if (plan.effective_plan === "basic") {
        // Chỉ bể đầu tiên của user được xem như bể Basic active
        const [userTanks] = await db.query(
          "SELECT id FROM tanks WHERE user_id = ? ORDER BY id ASC",
          [req.user.id]
        );

        const firstTankId = userTanks.length > 0 ? userTanks[0].id : null;

        if (Number(tank_id) !== Number(firstTankId)) {
          await createSystemLog({
            user_id: req.user.id,
            action: plan.is_premium_expired
              ? "create_device_failed_premium_expired_tank_limit"
              : "create_device_failed_basic_tank_limit",
            entity_type: "tank",
            entity_id: Number(tank_id),
            description: plan.is_premium_expired
              ? `Người dùng ${req.user.email} tạo thiết bị thất bại: Premium hết hạn, chỉ bể đầu tiên được hoạt động theo Basic`
              : `Người dùng ${req.user.email} tạo thiết bị thất bại: Basic chỉ cho phép sử dụng 1 bể`,
            ...requestInfo,
          });

          return res.status(403).json({
            message: plan.is_premium_expired
              ? "Gói Premium đã hết hạn. Theo giới hạn Basic, chỉ bể đầu tiên được phép hoạt động. Vui lòng liên hệ admin để gia hạn Premium."
              : "Gói Basic chỉ cho phép sử dụng 1 bể cá. Không thể thêm thiết bị vào bể vượt giới hạn.",
          });
        }

        const [deviceCountRows] = await db.query(
          "SELECT COUNT(*) AS total FROM devices WHERE tank_id = ?",
          [tank_id]
        );

        const totalDevices = deviceCountRows[0].total;

        if (totalDevices >= 3) {
          await createSystemLog({
            user_id: req.user.id,
            action: plan.is_premium_expired
              ? "create_device_failed_premium_expired_device_limit"
              : "create_device_failed_basic_device_limit",
            entity_type: "tank",
            entity_id: Number(tank_id),
            description: plan.is_premium_expired
              ? `Người dùng ${req.user.email} tạo thiết bị thất bại: Premium hết hạn, giới hạn Basic tối đa 3 thiết bị/bể. Bể "${tank.name}" hiện có ${totalDevices} thiết bị`
              : `Người dùng ${req.user.email} tạo thiết bị thất bại: Basic tối đa 3 thiết bị/bể. Bể "${tank.name}" hiện có ${totalDevices} thiết bị`,
            ...requestInfo,
          });

          return res.status(403).json({
            message: plan.is_premium_expired
              ? "Gói Premium đã hết hạn. Tài khoản hiện áp dụng giới hạn Basic: tối đa 3 thiết bị/bể. Vui lòng liên hệ admin để gia hạn Premium."
              : "Gói Basic chỉ cho phép tối đa 3 thiết bị trong một bể. Vui lòng liên hệ admin để nâng cấp Premium.",
          });
        }
      }
    }

    let finalDeviceCode = device_code || generateDeviceCode();

    // Đề phòng trùng device_code
    let duplicated = true;

    while (duplicated) {
      const [exists] = await db.query(
        "SELECT id FROM devices WHERE device_code = ?",
        [finalDeviceCode]
      );

      if (exists.length === 0) {
        duplicated = false;
      } else {
        finalDeviceCode = generateDeviceCode();
      }
    }

    const finalName = name || "ESP32 Aquarium";
    const finalHardwareVersion = hardware_version || "ESP32";
    const finalFirmwareVersion = firmware_version || "1.0.0";

    const [result] = await db.query(
      `INSERT INTO devices 
       (tank_id, device_code, name, hardware_version, firmware_version, last_seen, battery_level, rssi, status)
       VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, 'active')`,
      [
        tank_id,
        finalDeviceCode,
        finalName,
        finalHardwareVersion,
        finalFirmwareVersion,
        battery_level || null,
        rssi || null,
      ]
    );

    await createSystemLog({
      user_id: req.user.id,
      action: "create_device_success",
      entity_type: "device",
      entity_id: result.insertId,
      description: `Người dùng ${req.user.email} đã tạo thiết bị "${finalName}" mã ${finalDeviceCode} cho bể "${tank.name}"`,
      ...requestInfo,
    });

    res.json({
      message: "Tạo thiết bị thành công",
      device: {
        id: result.insertId,
        tank_id,
        device_code: finalDeviceCode,
        name: finalName,
        hardware_version: finalHardwareVersion,
        firmware_version: finalFirmwareVersion,
        battery_level: battery_level || null,
        rssi: rssi || null,
        status: "active",
      },
    });
  } catch (err) {
    console.error("Create device error:", err);
    res.status(500).json({ message: "Lỗi server khi tạo thiết bị" });
  }
});

module.exports = router;