const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const {
  createSystemLog,
  getRequestInfo,
} = require("../services/log.service");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "demo_secret_key";

const DEFAULT_THRESHOLDS = {
  temperature_min: 22,
  temperature_max: 30,
  ph_min: 6.5,
  ph_max: 8.0,
  water_level_min: 50,
  battery_min: 20,
  rssi_min: -80,
};

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

function isAdmin(role) {
  return role === "admin";
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

async function ensureThreshold(tankId) {
  await db.query(
    `INSERT IGNORE INTO alert_thresholds
     (tank_id, temperature_min, temperature_max, ph_min, ph_max, water_level_min, battery_min, rssi_min)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tankId,
      DEFAULT_THRESHOLDS.temperature_min,
      DEFAULT_THRESHOLDS.temperature_max,
      DEFAULT_THRESHOLDS.ph_min,
      DEFAULT_THRESHOLDS.ph_max,
      DEFAULT_THRESHOLDS.water_level_min,
      DEFAULT_THRESHOLDS.battery_min,
      DEFAULT_THRESHOLDS.rssi_min,
    ]
  );
}

async function getTankWithOwner(tankId, reqUser) {
  let rows;

  if (isManager(reqUser.role)) {
    [rows] = await db.query(
      `SELECT
        t.id,
        t.user_id,
        t.tank_code,
        t.name AS tank_name,
        t.status AS tank_status,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        u.role AS owner_role,
        u.plan_type,
        u.plan_expires_at
       FROM tanks t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.id = ?`,
      [tankId]
    );
  } else {
    [rows] = await db.query(
      `SELECT
        t.id,
        t.user_id,
        t.tank_code,
        t.name AS tank_name,
        t.status AS tank_status,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        u.role AS owner_role,
        u.plan_type,
        u.plan_expires_at
       FROM tanks t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.id = ? AND t.user_id = ?`,
      [tankId, reqUser.id]
    );
  }

  if (rows.length === 0) return null;

  const tank = rows[0];
  const plan = getEffectivePlanFromUser(tank);

  return {
    ...tank,
    effective_plan: isManager(reqUser.role) ? "manager" : plan.effective_plan,
    is_premium_expired: isManager(reqUser.role)
      ? false
      : plan.is_premium_expired,
  };
}

function validateThresholdInput(body) {
  const temperature_min = Number(body.temperature_min);
  const temperature_max = Number(body.temperature_max);
  const ph_min = Number(body.ph_min);
  const ph_max = Number(body.ph_max);
  const water_level_min = Number(body.water_level_min);
  const battery_min = Number(body.battery_min);
  const rssi_min = Number(body.rssi_min);

  if (
    Number.isNaN(temperature_min) ||
    Number.isNaN(temperature_max) ||
    Number.isNaN(ph_min) ||
    Number.isNaN(ph_max) ||
    Number.isNaN(water_level_min) ||
    Number.isNaN(battery_min) ||
    Number.isNaN(rssi_min)
  ) {
    return {
      ok: false,
      message: "Dữ liệu ngưỡng không hợp lệ",
    };
  }

  if (temperature_min >= temperature_max) {
    return {
      ok: false,
      message: "Nhiệt độ min phải nhỏ hơn nhiệt độ max",
    };
  }

  if (ph_min >= ph_max) {
    return {
      ok: false,
      message: "pH min phải nhỏ hơn pH max",
    };
  }

  if (ph_min < 0 || ph_max > 14) {
    return {
      ok: false,
      message: "pH phải nằm trong khoảng 0 đến 14",
    };
  }

  if (water_level_min < 0 || water_level_min > 100) {
    return {
      ok: false,
      message: "Mực nước tối thiểu phải nằm trong khoảng 0 đến 100",
    };
  }

  if (battery_min < 0 || battery_min > 100) {
    return {
      ok: false,
      message: "Pin tối thiểu phải nằm trong khoảng 0 đến 100",
    };
  }

  return {
    ok: true,
    values: {
      temperature_min,
      temperature_max,
      ph_min,
      ph_max,
      water_level_min,
      battery_min,
      rssi_min,
    },
  };
}
// ===============================
// LẤY DANH SÁCH NGƯỠNG
// ===============================
router.get("/", authMiddleware, async (req, res) => {
  try {
    let rows;

    if (isManager(req.user.role)) {
      [rows] = await db.query(
        `SELECT
          t.id AS tank_id,
          t.tank_code,
          t.name AS tank_name,
          t.status AS tank_status,
          u.id AS owner_id,
          u.email AS owner_email,
          u.full_name AS owner_full_name,
          u.plan_type,
          u.plan_expires_at,
          th.id AS threshold_id,
          COALESCE(th.temperature_min, 22) AS temperature_min,
          COALESCE(th.temperature_max, 30) AS temperature_max,
          COALESCE(th.ph_min, 6.5) AS ph_min,
          COALESCE(th.ph_max, 8.0) AS ph_max,
          COALESCE(th.water_level_min, 50) AS water_level_min,
          COALESCE(th.battery_min, 20) AS battery_min,
          COALESCE(th.rssi_min, -80) AS rssi_min,
          th.updated_at
         FROM tanks t
         LEFT JOIN users u ON t.user_id = u.id
         LEFT JOIN alert_thresholds th ON th.tank_id = t.id
         ORDER BY t.id DESC`
      );
    } else {
      [rows] = await db.query(
        `SELECT
          t.id AS tank_id,
          t.tank_code,
          t.name AS tank_name,
          t.status AS tank_status,
          u.id AS owner_id,
          u.email AS owner_email,
          u.full_name AS owner_full_name,
          u.plan_type,
          u.plan_expires_at,
          th.id AS threshold_id,
          COALESCE(th.temperature_min, 22) AS temperature_min,
          COALESCE(th.temperature_max, 30) AS temperature_max,
          COALESCE(th.ph_min, 6.5) AS ph_min,
          COALESCE(th.ph_max, 8.0) AS ph_max,
          COALESCE(th.water_level_min, 50) AS water_level_min,
          COALESCE(th.battery_min, 20) AS battery_min,
          COALESCE(th.rssi_min, -80) AS rssi_min,
          th.updated_at
         FROM tanks t
         LEFT JOIN users u ON t.user_id = u.id
         LEFT JOIN alert_thresholds th ON th.tank_id = t.id
         WHERE t.user_id = ?
         ORDER BY t.id DESC`,
        [req.user.id]
      );
    }

    const thresholds = rows.map((row) => {
      const plan = getEffectivePlanFromUser(row);

      return {
        ...row,
        effective_plan: isManager(req.user.role)
          ? "manager"
          : plan.effective_plan,
        is_premium_expired: isManager(req.user.role)
          ? false
          : plan.is_premium_expired,
        can_edit_threshold:
          isAdmin(req.user.role) ||
          (!isManager(req.user.role) && plan.effective_plan === "premium"),
      };
    });

    res.json({
      message: "Lấy danh sách ngưỡng cảnh báo thành công",
      thresholds,
    });
  } catch (err) {
    console.error("Get thresholds error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy danh sách ngưỡng cảnh báo",
    });
  }
});

// ===============================
// LẤY NGƯỠNG THEO TANK
// ===============================
router.get("/:tankId", authMiddleware, async (req, res) => {
  try {
    const tankId = Number(req.params.tankId);

    if (!tankId) {
      return res.status(400).json({ message: "Thiếu tank_id" });
    }

    const tank = await getTankWithOwner(tankId, req.user);

    if (!tank) {
      return res.status(404).json({
        message: "Không tìm thấy bể hoặc bạn không có quyền",
      });
    }

    await ensureThreshold(tankId);

    const [rows] = await db.query(
      `SELECT *
       FROM alert_thresholds
       WHERE tank_id = ?`,
      [tankId]
    );

    const plan = getEffectivePlanFromUser(tank);

    res.json({
      message: "Lấy ngưỡng cảnh báo thành công",
      tank,
      threshold: rows[0],
      can_edit_threshold:
        isAdmin(req.user.role) ||
        (!isManager(req.user.role) && plan.effective_plan === "premium"),
    });
  } catch (err) {
    console.error("Get threshold detail error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy ngưỡng cảnh báo",
    });
  }
});

// ===============================
// CẬP NHẬT NGƯỠNG THEO TANK
// ===============================
router.patch("/:tankId", authMiddleware, async (req, res) => {
  try {
    const requestInfo = getRequestInfo(req);
    const tankId = Number(req.params.tankId);

    if (!tankId) {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_threshold_failed_missing_tank_id",
        entity_type: "tank",
        entity_id: null,
        description: `Người dùng ${req.user.email} cập nhật ngưỡng thất bại: thiếu tank_id`,
        ...requestInfo,
      });

      return res.status(400).json({ message: "Thiếu tank_id" });
    }

    if (req.user.role === "moderator") {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_threshold_failed_no_permission",
        entity_type: "tank",
        entity_id: tankId,
        description: `Moderator ${req.user.email} bị chặn chỉnh ngưỡng bể ID ${tankId}`,
        ...requestInfo,
      });

      return res.status(403).json({
        message: "Moderator chỉ được xem ngưỡng, không được chỉnh sửa",
      });
    }

    const tank = await getTankWithOwner(tankId, req.user);

    if (!tank) {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_threshold_failed_tank_not_found",
        entity_type: "tank",
        entity_id: tankId,
        description: `Người dùng ${req.user.email} cập nhật ngưỡng thất bại: không tìm thấy bể ID ${tankId} hoặc không có quyền`,
        ...requestInfo,
      });

      return res.status(404).json({
        message: "Không tìm thấy bể hoặc bạn không có quyền",
      });
    }

    const plan = getEffectivePlanFromUser(tank);

    const canEdit =
      isAdmin(req.user.role) ||
      (!isManager(req.user.role) && plan.effective_plan === "premium");

    if (!canEdit) {
      await createSystemLog({
        user_id: req.user.id,
        action: plan.is_premium_expired
          ? "update_threshold_failed_premium_expired"
          : "update_threshold_failed_premium_required",
        entity_type: "tank",
        entity_id: tankId,
        description: plan.is_premium_expired
          ? `Người dùng ${req.user.email} cập nhật ngưỡng bể "${tank.tank_name}" thất bại: Premium đã hết hạn`
          : `Người dùng ${req.user.email} cập nhật ngưỡng bể "${tank.tank_name}" thất bại: cần gói Premium`,
        ...requestInfo,
      });

      return res.status(403).json({
        message: plan.is_premium_expired
          ? "Gói Premium đã hết hạn. Không thể chỉnh ngưỡng cảnh báo. Vui lòng liên hệ admin để gia hạn."
          : "Chỉ tài khoản Premium mới được chỉnh ngưỡng cảnh báo.",
      });
    }

    const validation = validateThresholdInput(req.body);

    if (!validation.ok) {
      await createSystemLog({
        user_id: req.user.id,
        action: "update_threshold_failed_invalid_value",
        entity_type: "tank",
        entity_id: tankId,
        description: `Người dùng ${req.user.email} cập nhật ngưỡng bể "${tank.tank_name}" thất bại: ${validation.message}`,
        ...requestInfo,
      });

      return res.status(400).json({
        message: validation.message,
      });
    }

    const v = validation.values;

    const [oldRows] = await db.query(
      "SELECT * FROM alert_thresholds WHERE tank_id = ?",
      [tankId]
    );

    const oldThreshold = oldRows[0] || null;

    await db.query(
      `INSERT INTO alert_thresholds
       (tank_id, temperature_min, temperature_max, ph_min, ph_max, water_level_min, battery_min, rssi_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         temperature_min = VALUES(temperature_min),
         temperature_max = VALUES(temperature_max),
         ph_min = VALUES(ph_min),
         ph_max = VALUES(ph_max),
         water_level_min = VALUES(water_level_min),
         battery_min = VALUES(battery_min),
         rssi_min = VALUES(rssi_min)`,
      [
        tankId,
        v.temperature_min,
        v.temperature_max,
        v.ph_min,
        v.ph_max,
        v.water_level_min,
        v.battery_min,
        v.rssi_min,
      ]
    );

    const [rows] = await db.query(
      "SELECT * FROM alert_thresholds WHERE tank_id = ?",
      [tankId]
    );

    await createSystemLog({
      user_id: req.user.id,
      action: "update_threshold_success",
      entity_type: "tank",
      entity_id: tankId,
      description:
        `Người dùng ${req.user.email} cập nhật ngưỡng cảnh báo cho bể "${tank.tank_name}". ` +
        `Cũ: ${
          oldThreshold
            ? `temp ${oldThreshold.temperature_min}-${oldThreshold.temperature_max}, pH ${oldThreshold.ph_min}-${oldThreshold.ph_max}, water ${oldThreshold.water_level_min}, battery ${oldThreshold.battery_min}, rssi ${oldThreshold.rssi_min}`
            : "chưa có"
        }. ` +
        `Mới: temp ${v.temperature_min}-${v.temperature_max}, pH ${v.ph_min}-${v.ph_max}, water ${v.water_level_min}, battery ${v.battery_min}, rssi ${v.rssi_min}`,
      ...requestInfo,
    });

    res.json({
      message: "Cập nhật ngưỡng cảnh báo thành công",
      threshold: rows[0],
    });
  } catch (err) {
    console.error("Update threshold error:", err);
    res.status(500).json({
      message: "Lỗi server khi cập nhật ngưỡng cảnh báo",
    });
  }
});

module.exports = router;