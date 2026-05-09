const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const mqttClient = require("../config/mqtt");
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

function toBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeState(row) {
  return {
    id: row?.id || null,
    device_id: row?.device_id || null,
    tank_id: row?.tank_id || null,
    pump: Boolean(row?.pump),
    light: Boolean(row?.light),
    oxygen: Boolean(row?.oxygen),
    auto_mode: Boolean(row?.auto_mode),
    last_command_by: row?.last_command_by || null,
    last_command_at: row?.last_command_at || null,
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
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
        d.last_seen,
        d.battery_level,
        d.rssi,
        t.name AS tank_name,
        t.tank_code,
        t.status AS tank_status,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        u.role AS owner_role,
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
        d.last_seen,
        d.battery_level,
        d.rssi,
        t.name AS tank_name,
        t.tank_code,
        t.status AS tank_status,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name,
        u.role AS owner_role,
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

  return rows[0];
}

async function ensureActuatorState(device) {
  await db.query(
    `INSERT IGNORE INTO actuator_states
     (device_id, tank_id, pump, light, oxygen, auto_mode)
     VALUES (?, ?, 0, 0, 0, 0)`,
    [device.id, device.tank_id]
  );

  const [rows] = await db.query(
    `SELECT *
     FROM actuator_states
     WHERE device_id = ?`,
    [device.id]
  );

  return normalizeState(rows[0]);
}

function publishMqtt(topic, payload) {
  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      JSON.stringify(payload),
      {
        qos: 1,
        retain: false,
      },
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

// ===============================
// LẤY DANH SÁCH TRẠNG THÁI ĐIỀU KHIỂN
// ===============================
router.get("/", authMiddleware, async (req, res) => {
  try {
    let rows;

    if (isManager(req.user.role)) {
      [rows] = await db.query(
        `SELECT
          d.id AS device_id,
          d.tank_id,
          d.device_code,
          d.name AS device_name,
          d.status AS device_status,
          d.last_seen,
          d.battery_level,
          d.rssi,
          t.name AS tank_name,
          t.tank_code,
          t.status AS tank_status,
          u.id AS owner_id,
          u.email AS owner_email,
          a.id AS actuator_id,
          a.pump,
          a.light,
          a.oxygen,
          a.auto_mode,
          a.last_command_by,
          a.last_command_at,
          a.updated_at
         FROM devices d
         LEFT JOIN tanks t ON d.tank_id = t.id
         LEFT JOIN users u ON t.user_id = u.id
         LEFT JOIN actuator_states a ON a.device_id = d.id
         ORDER BY d.id DESC`
      );
    } else {
      [rows] = await db.query(
        `SELECT
          d.id AS device_id,
          d.tank_id,
          d.device_code,
          d.name AS device_name,
          d.status AS device_status,
          d.last_seen,
          d.battery_level,
          d.rssi,
          t.name AS tank_name,
          t.tank_code,
          t.status AS tank_status,
          u.id AS owner_id,
          u.email AS owner_email,
          a.id AS actuator_id,
          a.pump,
          a.light,
          a.oxygen,
          a.auto_mode,
          a.last_command_by,
          a.last_command_at,
          a.updated_at
         FROM devices d
         LEFT JOIN tanks t ON d.tank_id = t.id
         LEFT JOIN users u ON t.user_id = u.id
         LEFT JOIN actuator_states a ON a.device_id = d.id
         WHERE u.id = ?
         ORDER BY d.id DESC`,
        [req.user.id]
      );
    }

    const controls = rows.map((row) => {
      const state = normalizeState({
        id: row.actuator_id,
        device_id: row.device_id,
        tank_id: row.tank_id,
        pump: row.pump || 0,
        light: row.light || 0,
        oxygen: row.oxygen || 0,
        auto_mode: row.auto_mode || 0,
        last_command_by: row.last_command_by,
        last_command_at: row.last_command_at,
        updated_at: row.updated_at,
      });

      return {
        device: {
          id: row.device_id,
          tank_id: row.tank_id,
          device_code: row.device_code,
          name: row.device_name,
          status: row.device_status,
          last_seen: row.last_seen,
          battery_level: row.battery_level,
          rssi: row.rssi,
          tank_name: row.tank_name,
          tank_code: row.tank_code,
          tank_status: row.tank_status,
          owner_id: row.owner_id,
          owner_email: row.owner_email,
        },
        state,
        control_topic: `aquarium/${row.owner_id}/${row.tank_id}/control`,
      };
    });

    res.json({
      message: "Lấy danh sách điều khiển thiết bị thành công",
      controls,
    });
  } catch (err) {
    console.error("Get actuator list error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy danh sách điều khiển thiết bị",
    });
  }
});

// ===============================
// LẤY TRẠNG THÁI ĐIỀU KHIỂN 1 THIẾT BỊ
// ===============================
router.get("/devices/:deviceId", authMiddleware, async (req, res) => {
  try {
    const deviceId = Number(req.params.deviceId);

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

    const state = await ensureActuatorState(device);

    res.json({
      message: "Lấy trạng thái điều khiển thành công",
      device,
      state,
      control_topic: `aquarium/${device.owner_id}/${device.tank_id}/control`,
    });
  } catch (err) {
    console.error("Get actuator detail error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy trạng thái điều khiển",
    });
  }
});

// ===============================
// CẬP NHẬT TRẠNG THÁI ĐIỀU KHIỂN
// Admin hoặc chủ thiết bị được điều khiển
// Moderator chỉ xem
// ===============================
router.patch("/devices/:deviceId", authMiddleware, async (req, res) => {
  try {
    const requestInfo = getRequestInfo(req);
    const deviceId = Number(req.params.deviceId);

    if (!deviceId) {
      await createSystemLog({
        user_id: req.user.id,
        action: "control_actuator_failed_missing_device_id",
        entity_type: "device",
        entity_id: null,
        description: `Người dùng ${req.user.email} điều khiển thiết bị thất bại: thiếu device_id`,
        ...requestInfo,
      });

      return res.status(400).json({ message: "Thiếu device_id" });
    }

    if (req.user.role === "moderator") {
      await createSystemLog({
        user_id: req.user.id,
        action: "control_actuator_failed_no_permission",
        entity_type: "device",
        entity_id: deviceId,
        description: `Moderator ${req.user.email} bị chặn điều khiển thiết bị ID ${deviceId}`,
        ...requestInfo,
      });

      return res.status(403).json({
        message: "Moderator chỉ được xem, không được điều khiển thiết bị",
      });
    }

    const hasAnyControl =
      req.body.pump !== undefined ||
      req.body.light !== undefined ||
      req.body.oxygen !== undefined ||
      req.body.auto_mode !== undefined ||
      req.body.feed !== undefined;

    if (!hasAnyControl) {
      await createSystemLog({
        user_id: req.user.id,
        action: "control_actuator_failed_invalid_payload",
        entity_type: "device",
        entity_id: deviceId,
        description: `Người dùng ${req.user.email} điều khiển thiết bị ID ${deviceId} thất bại: payload không có pump/light/oxygen/auto_mode/feed`,
        ...requestInfo,
      });

      return res.status(400).json({
        message:
          "Payload phải có ít nhất một trường: pump, light, oxygen, auto_mode, feed",
      });
    }

    const device = await getDeviceWithOwner(deviceId, req.user);

    if (!device) {
      await createSystemLog({
        user_id: req.user.id,
        action: "control_actuator_failed_device_not_found",
        entity_type: "device",
        entity_id: deviceId,
        description: `Người dùng ${req.user.email} điều khiển thiết bị thất bại: không tìm thấy thiết bị ID ${deviceId} hoặc không có quyền`,
        ...requestInfo,
      });

      return res.status(404).json({
        message:
          "Không tìm thấy thiết bị hoặc bạn không có quyền điều khiển thiết bị này",
      });
    }

    if (
      !isAdmin(req.user.role) &&
      Number(device.owner_id) !== Number(req.user.id)
    ) {
      await createSystemLog({
        user_id: req.user.id,
        action: "control_actuator_failed_no_permission",
        entity_type: "device",
        entity_id: deviceId,
        description: `Người dùng ${req.user.email} không có quyền điều khiển thiết bị ${device.device_code}`,
        ...requestInfo,
      });

      return res.status(403).json({
        message: "Bạn không có quyền điều khiển thiết bị này",
      });
    }

    if (
      device.tank_status === "suspended" ||
      device.device_status === "suspended"
    ) {
      await createSystemLog({
        user_id: req.user.id,
        action: "control_actuator_failed_suspended",
        entity_type: "device",
        entity_id: deviceId,
        description: `Người dùng ${req.user.email} điều khiển thiết bị ${device.device_code} thất bại: bể hoặc thiết bị đang bị tạm khóa`,
        ...requestInfo,
      });

      return res.status(403).json({
        message: "Bể cá hoặc thiết bị đang bị tạm khóa, không thể điều khiển",
      });
    }

    const currentState = await ensureActuatorState(device);

    const nextState = {
      pump:
        req.body.pump !== undefined ? toBool(req.body.pump) : currentState.pump,
      light:
        req.body.light !== undefined
          ? toBool(req.body.light)
          : currentState.light,
      oxygen:
        req.body.oxygen !== undefined
          ? toBool(req.body.oxygen)
          : currentState.oxygen,
      auto_mode:
        req.body.auto_mode !== undefined
          ? toBool(req.body.auto_mode)
          : currentState.auto_mode,
    };

    await db.query(
      `UPDATE actuator_states
       SET pump = ?,
           light = ?,
           oxygen = ?,
           auto_mode = ?,
           last_command_by = ?,
           last_command_at = NOW()
       WHERE device_id = ?`,
      [
        nextState.pump ? 1 : 0,
        nextState.light ? 1 : 0,
        nextState.oxygen ? 1 : 0,
        nextState.auto_mode ? 1 : 0,
        req.user.id,
        deviceId,
      ]
    );

    const topic = `aquarium/${device.owner_id}/${device.tank_id}/control`;

    const isFeedCommand =
      req.body.feed !== undefined ? toBool(req.body.feed) : false;

    const commandPayload = {
      command_id: `${Date.now()}_${deviceId}`,
      source: "web",
      device_id: deviceId,
      tank_id: device.tank_id,
      pump: nextState.pump,
      light: nextState.light,
      oxygen: nextState.oxygen,
      auto_mode: nextState.auto_mode,
      feed: isFeedCommand,
      servo_angle: isFeedCommand ? 90 : undefined,
      timestamp: new Date().toISOString(),
    };

    // Payload gửi thật xuống ESP qua MQTT.
    // Có token để ESP xác thực lệnh, nhưng không trả token về frontend.
    const mqttPayload = {
      ...commandPayload,
    };

    if (process.env.DEVICE_MQTT_TOKEN) {
      mqttPayload.device_token = process.env.DEVICE_MQTT_TOKEN;
    }

    await publishMqtt(topic, mqttPayload);

    const [stateRows] = await db.query(
      `SELECT *
       FROM actuator_states
       WHERE device_id = ?`,
      [deviceId]
    );

    const updatedState = normalizeState(stateRows[0]);

    await createSystemLog({
      user_id: req.user.id,
      action: "control_actuator_success",
      entity_type: "device",
      entity_id: deviceId,
      description:
        `Người dùng ${req.user.email} điều khiển thiết bị ${device.device_code}. ` +
        `Topic: ${topic}. ` +
        `Pump=${nextState.pump ? "ON" : "OFF"}, ` +
        `Light=${nextState.light ? "ON" : "OFF"}, ` +
        `Oxygen=${nextState.oxygen ? "ON" : "OFF"}, ` +
        `Auto=${nextState.auto_mode ? "ON" : "OFF"}, ` +
        `Feed=${isFeedCommand ? "YES" : "NO"}`,
      ...requestInfo,
    });

    res.json({
      message: isFeedCommand
        ? "Đã gửi lệnh cho ăn tới thiết bị"
        : "Điều khiển thiết bị thành công",
      device,
      state: updatedState,
      control_topic: topic,
      mqtt_payload: commandPayload,
    });
  } catch (err) {
    console.error("Update actuator error:", err);
    res.status(500).json({
      message: "Lỗi server khi điều khiển thiết bị",
    });
  }
});

module.exports = router;