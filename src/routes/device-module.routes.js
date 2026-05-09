const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const {
  createSystemLog,
  getRequestInfo,
} = require("../services/log.service");

const { publishDeviceConfig } = require("../services/mqtt.service");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "demo_secret_key";

const ESP32_SAFE_GPIO_PINS = [
  4, 5, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33,
];

const INPUT_MODULE_TYPES = [
  "ds18b20",
  "hc_sr04",
  "ph_sensor",
  "turbidity_sensor",
  "dht22",
  "analog_sensor",
];

const OUTPUT_MODULE_TYPES = [
  "light",
  "servo_feeder",
  "pump",
  "oxygen",
  "buzzer",
  "relay",
];

const WIRELESS_PROTOCOLS = ["esp_now", "mqtt_direct"];

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
  } catch {
    return res.status(401).json({
      message: "Token hết hạn hoặc không hợp lệ",
    });
  }
}

function isAdmin(role) {
  return role === "admin";
}

function isManager(role) {
  return role === "admin" || role === "moderator";
}

async function publishDeviceConfigSafely(deviceId, meta = {}) {
  try {
    return await publishDeviceConfig(deviceId, meta);
  } catch (err) {
    console.error("Publish device config failed:", err);

    return {
      ok: false,
      error: err.message || "Publish config thất bại",
    };
  }
}

function normalizeBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeConfigJson(value) {
  if (!value) return null;

  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify({});
    }
  }

  return JSON.stringify(value);
}

function parseConfigJson(value) {
  if (!value) return null;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getPinsFromModule(module) {
  return [module.pin, module.pin2, module.pin3]
    .filter((pin) => pin !== null && pin !== undefined && pin !== "")
    .map((pin) => Number(pin))
    .filter((pin) => Number.isFinite(pin));
}

function normalizeModule(row) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    config_json: parseConfigJson(row.config_json),
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
        t.name AS tank_name,
        t.tank_code,
        t.status AS tank_status,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name
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
        t.name AS tank_name,
        t.tank_code,
        t.status AS tank_status,
        u.id AS owner_id,
        u.email AS owner_email,
        u.full_name AS owner_full_name
       FROM devices d
       LEFT JOIN tanks t ON d.tank_id = t.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE d.id = ? AND u.id = ?`,
      [deviceId, reqUser.id]
    );
  }

  return rows[0] || null;
}

async function getModuleWithOwner(moduleId, reqUser) {
  let rows;

  if (isManager(reqUser.role)) {
    [rows] = await db.query(
      `SELECT
        m.*,
        d.device_code,
        d.name AS device_name,
        t.name AS tank_name,
        t.tank_code,
        u.id AS owner_id,
        u.email AS owner_email
       FROM device_modules m
       LEFT JOIN devices d ON m.device_id = d.id
       LEFT JOIN tanks t ON m.tank_id = t.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE m.id = ?`,
      [moduleId]
    );
  } else {
    [rows] = await db.query(
      `SELECT
        m.*,
        d.device_code,
        d.name AS device_name,
        t.name AS tank_name,
        t.tank_code,
        u.id AS owner_id,
        u.email AS owner_email
       FROM device_modules m
       LEFT JOIN devices d ON m.device_id = d.id
       LEFT JOIN tanks t ON m.tank_id = t.id
       LEFT JOIN users u ON t.user_id = u.id
       WHERE m.id = ? AND u.id = ?`,
      [moduleId, reqUser.id]
    );
  }

  return rows[0] || null;
}

async function getUsedPins(deviceId, excludeModuleId = null) {
  const params = [deviceId];
  let excludeSql = "";

  if (excludeModuleId) {
    excludeSql = " AND id <> ?";
    params.push(excludeModuleId);
  }

  const [rows] = await db.query(
    `SELECT id, name, module_type, pin, pin2, pin3
     FROM device_modules
     WHERE device_id = ?
       AND connection_type = 'gpio'
       AND enabled = 1
       ${excludeSql}`,
    params
  );

  const used = [];

  for (const row of rows) {
    for (const pin of getPinsFromModule(row)) {
      used.push({
        pin,
        module_id: row.id,
        module_name: row.name,
        module_type: row.module_type,
      });
    }
  }

  return used;
}

function validateModulePayload(body, isUpdate = false) {
  const errors = [];

  const connectionType = body.connection_type;
  const ioMode = body.io_mode;
  const moduleType = body.module_type;

  if (!isUpdate || connectionType !== undefined) {
    if (!["gpio", "wireless"].includes(connectionType)) {
      errors.push("connection_type phải là gpio hoặc wireless");
    }
  }

  if (!isUpdate || ioMode !== undefined) {
    if (!["input", "output"].includes(ioMode)) {
      errors.push("io_mode phải là input hoặc output");
    }
  }

  if (!isUpdate || moduleType !== undefined) {
    if (!moduleType || typeof moduleType !== "string") {
      errors.push("Thiếu module_type");
    }
  }

  if (ioMode === "input" && moduleType && !INPUT_MODULE_TYPES.includes(moduleType)) {
    errors.push(`module_type input chưa hỗ trợ: ${moduleType}`);
  }

  if (
    ioMode === "output" &&
    moduleType &&
    !OUTPUT_MODULE_TYPES.includes(moduleType)
  ) {
    errors.push(`module_type output chưa hỗ trợ: ${moduleType}`);
  }

  if (connectionType === "gpio") {
    const pins = [body.pin, body.pin2, body.pin3]
      .filter((pin) => pin !== null && pin !== undefined && pin !== "")
      .map(Number);

    if (pins.length === 0) {
      errors.push("Module GPIO phải có ít nhất pin chính");
    }

    for (const pin of pins) {
      if (!ESP32_SAFE_GPIO_PINS.includes(pin)) {
        errors.push(`GPIO ${pin} không nằm trong danh sách pin an toàn`);
      }
    }

    const uniquePins = new Set(pins);

    if (uniquePins.size !== pins.length) {
      errors.push("Các pin trong cùng module không được trùng nhau");
    }
  }

  if (connectionType === "wireless") {
    if (!body.protocol || !WIRELESS_PROTOCOLS.includes(body.protocol)) {
      errors.push("Module không dây phải có protocol hợp lệ");
    }

    if (!body.node_code || !String(body.node_code).trim()) {
      errors.push("Module không dây phải có node_code");
    }

    if (!body.node_type || !String(body.node_type).trim()) {
      errors.push("Module không dây phải có node_type");
    }
  }

  return errors;
}

// ===============================
// META OPTION CHO UI
// ===============================
router.get("/meta/options", authMiddleware, async (req, res) => {
  res.json({
    message: "Lấy cấu hình module options thành công",
    gpio_pins: ESP32_SAFE_GPIO_PINS,
    connection_types: ["gpio", "wireless"],
    io_modes: ["input", "output"],
    input_module_types: INPUT_MODULE_TYPES,
    output_module_types: OUTPUT_MODULE_TYPES,
    wireless_protocols: WIRELESS_PROTOCOLS,
  });
});

// ===============================
// LẤY DANH SÁCH MODULE
// ===============================
router.get("/", authMiddleware, async (req, res) => {
  try {
    let rows;

    if (isManager(req.user.role)) {
      [rows] = await db.query(
        `SELECT
          m.*,
          d.device_code,
          d.name AS device_name,
          t.name AS tank_name,
          t.tank_code,
          u.id AS owner_id,
          u.email AS owner_email
         FROM device_modules m
         LEFT JOIN devices d ON m.device_id = d.id
         LEFT JOIN tanks t ON m.tank_id = t.id
         LEFT JOIN users u ON t.user_id = u.id
         ORDER BY m.id DESC`
      );
    } else {
      [rows] = await db.query(
        `SELECT
          m.*,
          d.device_code,
          d.name AS device_name,
          t.name AS tank_name,
          t.tank_code,
          u.id AS owner_id,
          u.email AS owner_email
         FROM device_modules m
         LEFT JOIN devices d ON m.device_id = d.id
         LEFT JOIN tanks t ON m.tank_id = t.id
         LEFT JOIN users u ON t.user_id = u.id
         WHERE u.id = ?
         ORDER BY m.id DESC`,
        [req.user.id]
      );
    }

    res.json({
      message: "Lấy danh sách module thành công",
      modules: rows.map(normalizeModule),
    });
  } catch (err) {
    console.error("Get device modules error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy danh sách module",
    });
  }
});

// ===============================
// LẤY MODULE THEO DEVICE
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
        message: "Không tìm thấy thiết bị hoặc bạn không có quyền xem",
      });
    }

    const [rows] = await db.query(
      `SELECT *
       FROM device_modules
       WHERE device_id = ?
       ORDER BY id DESC`,
      [deviceId]
    );

    const usedPins = await getUsedPins(deviceId);

    res.json({
      message: "Lấy module theo thiết bị thành công",
      device,
      modules: rows.map(normalizeModule),
      gpio: {
        safe_pins: ESP32_SAFE_GPIO_PINS,
        used_pins: usedPins,
        free_pins: ESP32_SAFE_GPIO_PINS.filter(
          (pin) => !usedPins.some((item) => Number(item.pin) === Number(pin))
        ),
      },
    });
  } catch (err) {
    console.error("Get device modules by device error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy module theo thiết bị",
    });
  }
});

// ===============================
// LẤY PIN TRỐNG THEO DEVICE
// ===============================
router.get("/devices/:deviceId/free-pins", authMiddleware, async (req, res) => {
  try {
    const deviceId = Number(req.params.deviceId);

    if (!deviceId) {
      return res.status(400).json({ message: "Thiếu device_id" });
    }

    const device = await getDeviceWithOwner(deviceId, req.user);

    if (!device) {
      return res.status(404).json({
        message: "Không tìm thấy thiết bị hoặc bạn không có quyền xem",
      });
    }

    const usedPins = await getUsedPins(deviceId);

    res.json({
      message: "Lấy GPIO trống thành công",
      device,
      safe_pins: ESP32_SAFE_GPIO_PINS,
      used_pins: usedPins,
      free_pins: ESP32_SAFE_GPIO_PINS.filter(
        (pin) => !usedPins.some((item) => Number(item.pin) === Number(pin))
      ),
    });
  } catch (err) {
    console.error("Get free pins error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy GPIO trống",
    });
  }
});
// ===============================
// PUBLISH CONFIG XUỐNG ESP THỦ CÔNG
// ===============================
router.post("/devices/:deviceId/publish-config", authMiddleware, async (req, res) => {
  try {
    const deviceId = Number(req.params.deviceId);

    if (!deviceId) {
      return res.status(400).json({
        message: "Thiếu device_id",
      });
    }

    if (req.user.role === "moderator") {
      return res.status(403).json({
        message: "Moderator chỉ được xem, không được gửi config xuống thiết bị",
      });
    }

    const device = await getDeviceWithOwner(deviceId, req.user);

    if (!device) {
      return res.status(404).json({
        message: "Không tìm thấy thiết bị hoặc bạn không có quyền gửi config",
      });
    }

    const configPublish = await publishDeviceConfigSafely(deviceId, {
      reason: "manual_publish",
    });

    res.json({
      message: configPublish.ok
        ? "Đã gửi config xuống ESP"
        : "Không gửi được config xuống ESP",
      config_publish: configPublish,
    });
  } catch (err) {
    console.error("Manual publish config error:", err);

    res.status(500).json({
      message: "Lỗi server khi gửi config xuống ESP",
    });
  }
});
// ===============================
// TẠO MODULE
// ===============================
router.post("/", authMiddleware, async (req, res) => {
  try {
    const requestInfo = getRequestInfo(req);

    if (req.user.role === "moderator") {
      return res.status(403).json({
        message: "Moderator chỉ được xem, không được tạo module",
      });
    }

    const {
      device_id,
      module_code,
      name,
      connection_type,
      io_mode,
      module_type,
      pin,
      pin2,
      pin3,
      unit,
      protocol,
      node_type,
      node_code,
      config_json,
      enabled,
    } = req.body;

    const deviceId = Number(device_id);

    if (!deviceId) {
      return res.status(400).json({
        message: "Thiếu device_id",
      });
    }

    if (!module_code || !String(module_code).trim()) {
      return res.status(400).json({
        message: "Thiếu module_code",
      });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        message: "Thiếu tên module",
      });
    }

    const errors = validateModulePayload(req.body, false);

    if (errors.length > 0) {
      return res.status(400).json({
        message: errors.join(". "),
      });
    }

    const device = await getDeviceWithOwner(deviceId, req.user);

    if (!device) {
      return res.status(404).json({
        message: "Không tìm thấy thiết bị hoặc bạn không có quyền tạo module",
      });
    }

    const pinsToUse =
      connection_type === "gpio"
        ? [pin, pin2, pin3]
            .filter((value) => value !== null && value !== undefined && value !== "")
            .map(Number)
        : [];

    if (pinsToUse.length > 0) {
      const usedPins = await getUsedPins(deviceId);
      const conflict = usedPins.find((item) => pinsToUse.includes(Number(item.pin)));

      if (conflict) {
        return res.status(409).json({
          message: `GPIO ${conflict.pin} đã được dùng bởi module ${conflict.module_name}`,
        });
      }
    }

    const [result] = await db.query(
      `INSERT INTO device_modules
       (device_id, tank_id, module_code, name, connection_type, io_mode,
        module_type, pin, pin2, pin3, unit, protocol, node_type, node_code,
        config_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        deviceId,
        device.tank_id,
        String(module_code).trim(),
        String(name).trim(),
        connection_type,
        io_mode,
        module_type,
        pin || null,
        pin2 || null,
        pin3 || null,
        unit || null,
        protocol || null,
        node_type || null,
        node_code || null,
        normalizeConfigJson(config_json),
        enabled === undefined ? 1 : normalizeBool(enabled) ? 1 : 0,
      ]
    );

    await createSystemLog({
      user_id: req.user.id,
      action: "create_device_module_success",
      entity_type: "device_module",
      entity_id: result.insertId,
      description: `Người dùng ${req.user.email} đã tạo module ${module_code} cho thiết bị ${device.device_code}`,
      ...requestInfo,
    });

    const [rows] = await db.query(
      `SELECT *
       FROM device_modules
       WHERE id = ?`,
      [result.insertId]
    );

    const configPublish = await publishDeviceConfigSafely(deviceId, {
  reason: "module_created",
  changed_module_id: result.insertId,
});

res.json({
  message: "Tạo module thành công",
  module: normalizeModule(rows[0]),
  config_publish: configPublish,
});
  } catch (err) {
    console.error("Create device module error:", err);

    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "module_code đã tồn tại trên thiết bị này",
      });
    }

    res.status(500).json({
      message: "Lỗi server khi tạo module",
    });
  }
});

// ===============================
// CẬP NHẬT MODULE
// ===============================
router.patch("/:moduleId", authMiddleware, async (req, res) => {
  try {
    const requestInfo = getRequestInfo(req);
    const moduleId = Number(req.params.moduleId);

    if (!moduleId) {
      return res.status(400).json({ message: "Thiếu module_id" });
    }

    if (req.user.role === "moderator") {
      return res.status(403).json({
        message: "Moderator chỉ được xem, không được sửa module",
      });
    }

    const current = await getModuleWithOwner(moduleId, req.user);

    if (!current) {
      return res.status(404).json({
        message: "Không tìm thấy module hoặc bạn không có quyền sửa",
      });
    }

    const nextPayload = {
      ...current,
      ...req.body,
      connection_type: req.body.connection_type ?? current.connection_type,
      io_mode: req.body.io_mode ?? current.io_mode,
      module_type: req.body.module_type ?? current.module_type,
      pin: req.body.pin ?? current.pin,
      pin2: req.body.pin2 ?? current.pin2,
      pin3: req.body.pin3 ?? current.pin3,
      protocol: req.body.protocol ?? current.protocol,
      node_type: req.body.node_type ?? current.node_type,
      node_code: req.body.node_code ?? current.node_code,
    };

    const errors = validateModulePayload(nextPayload, true);

    if (errors.length > 0) {
      return res.status(400).json({
        message: errors.join(". "),
      });
    }

    const pinsToUse =
      nextPayload.connection_type === "gpio"
        ? [nextPayload.pin, nextPayload.pin2, nextPayload.pin3]
            .filter((value) => value !== null && value !== undefined && value !== "")
            .map(Number)
        : [];

    if (pinsToUse.length > 0) {
      const usedPins = await getUsedPins(current.device_id, moduleId);
      const conflict = usedPins.find((item) => pinsToUse.includes(Number(item.pin)));

      if (conflict) {
        return res.status(409).json({
          message: `GPIO ${conflict.pin} đã được dùng bởi module ${conflict.module_name}`,
        });
      }
    }

    await db.query(
      `UPDATE device_modules
       SET module_code = ?,
           name = ?,
           connection_type = ?,
           io_mode = ?,
           module_type = ?,
           pin = ?,
           pin2 = ?,
           pin3 = ?,
           unit = ?,
           protocol = ?,
           node_type = ?,
           node_code = ?,
           config_json = ?,
           enabled = ?
       WHERE id = ?`,
      [
        req.body.module_code ?? current.module_code,
        req.body.name ?? current.name,
        nextPayload.connection_type,
        nextPayload.io_mode,
        nextPayload.module_type,
        nextPayload.connection_type === "gpio" ? nextPayload.pin || null : null,
        nextPayload.connection_type === "gpio" ? nextPayload.pin2 || null : null,
        nextPayload.connection_type === "gpio" ? nextPayload.pin3 || null : null,
        req.body.unit ?? current.unit,
        nextPayload.connection_type === "wireless" ? nextPayload.protocol : null,
        nextPayload.connection_type === "wireless" ? nextPayload.node_type : null,
        nextPayload.connection_type === "wireless" ? nextPayload.node_code : null,
        req.body.config_json !== undefined
          ? normalizeConfigJson(req.body.config_json)
          : current.config_json,
        req.body.enabled === undefined
          ? current.enabled
          : normalizeBool(req.body.enabled)
          ? 1
          : 0,
        moduleId,
      ]
    );

    await createSystemLog({
      user_id: req.user.id,
      action: "update_device_module_success",
      entity_type: "device_module",
      entity_id: moduleId,
      description: `Người dùng ${req.user.email} đã cập nhật module ${current.module_code}`,
      ...requestInfo,
    });

    const [rows] = await db.query(
      `SELECT *
       FROM device_modules
       WHERE id = ?`,
      [moduleId]
    );

    const configPublish = await publishDeviceConfigSafely(current.device_id, {
  reason: "module_updated",
  changed_module_id: moduleId,
});

res.json({
  message: "Cập nhật module thành công",
  module: normalizeModule(rows[0]),
  config_publish: configPublish,
});
  } catch (err) {
    console.error("Update device module error:", err);

    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "module_code đã tồn tại trên thiết bị này",
      });
    }

    res.status(500).json({
      message: "Lỗi server khi cập nhật module",
    });
  }
});

// ===============================
// XÓA MODULE
// ===============================
router.delete("/:moduleId", authMiddleware, async (req, res) => {
  try {
    const requestInfo = getRequestInfo(req);
    const moduleId = Number(req.params.moduleId);

    if (!moduleId) {
      return res.status(400).json({ message: "Thiếu module_id" });
    }

    if (req.user.role === "moderator") {
      return res.status(403).json({
        message: "Moderator chỉ được xem, không được xóa module",
      });
    }

    const current = await getModuleWithOwner(moduleId, req.user);

    if (!current) {
      return res.status(404).json({
        message: "Không tìm thấy module hoặc bạn không có quyền xóa",
      });
    }

    await db.query(`DELETE FROM device_modules WHERE id = ?`, [moduleId]);
    const configPublish = await publishDeviceConfigSafely(current.device_id, {
  reason: "module_deleted",
  changed_module_id: moduleId,
});
    await createSystemLog({
      user_id: req.user.id,
      action: "delete_device_module_success",
      entity_type: "device_module",
      entity_id: moduleId,
      description: `Người dùng ${req.user.email} đã xóa module ${current.module_code}`,
      ...requestInfo,
    });

    res.json({
  message: "Xóa module thành công",
  module: normalizeModule(current),
  config_publish: configPublish,
});
  } catch (err) {
    console.error("Delete device module error:", err);
    res.status(500).json({
      message: "Lỗi server khi xóa module",
    });
  }
});

module.exports = router;