const mqttClient = require("../config/mqtt");
const db = require("../config/db");

const DEFAULT_THRESHOLDS = {
  temperature_min: 22,
  temperature_max: 30,
  ph_min: 6.5,
  ph_max: 8.0,
  water_level_min: 50,
  battery_min: 20,
  rssi_min: -80,
};

// Để TRUE cho dễ demo lịch sử cảnh báo.
// Nếu muốn đúng bảng gói dịch vụ: Basic chỉ hiện cảnh báo web, Premium mới lưu lịch sử
// thì đổi thành false.
const SAVE_ALERT_HISTORY_FOR_BASIC = true;

function getEffectivePlan(user) {
  const isPremium = user.plan_type === "premium";

  const isExpired =
    isPremium &&
    user.plan_expires_at &&
    new Date(user.plan_expires_at).getTime() < Date.now();

  const isPremiumActive = isPremium && !isExpired;

  return {
    effective_plan: isPremiumActive ? "premium" : "basic",
    is_premium_expired: Boolean(isExpired),
  };
}

async function getThreshold(tankId) {
  const [rows] = await db.query(
    `SELECT *
     FROM alert_thresholds
     WHERE tank_id = ?`,
    [tankId]
  );

  if (rows.length > 0) {
    return rows[0];
  }

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

  return {
    tank_id: tankId,
    ...DEFAULT_THRESHOLDS,
  };
}

function buildAlerts(payload, threshold) {
  const alerts = [];

  const temperature =
    payload.temperature !== undefined ? Number(payload.temperature) : null;
  const ph = payload.ph !== undefined ? Number(payload.ph) : null;
  const waterLevel =
    payload.water_level !== undefined ? Number(payload.water_level) : null;
  const battery = payload.battery !== undefined ? Number(payload.battery) : null;
  const rssi = payload.rssi !== undefined ? Number(payload.rssi) : null;

  if (temperature !== null && temperature > threshold.temperature_max) {
    alerts.push({
      alert_type: "temperature_high",
      message: `Nhiệt độ cao bất thường: ${temperature}°C, vượt ngưỡng ${threshold.temperature_max}°C`,
      current_value: temperature,
      threshold_value: threshold.temperature_max,
      severity: "high",
    });
  }

  if (temperature !== null && temperature < threshold.temperature_min) {
    alerts.push({
      alert_type: "temperature_low",
      message: `Nhiệt độ thấp bất thường: ${temperature}°C, thấp hơn ngưỡng ${threshold.temperature_min}°C`,
      current_value: temperature,
      threshold_value: threshold.temperature_min,
      severity: "medium",
    });
  }

  if (ph !== null && ph > threshold.ph_max) {
    alerts.push({
      alert_type: "ph_high",
      message: `pH cao bất thường: ${ph}, vượt ngưỡng ${threshold.ph_max}`,
      current_value: ph,
      threshold_value: threshold.ph_max,
      severity: "high",
    });
  }

  if (ph !== null && ph < threshold.ph_min) {
    alerts.push({
      alert_type: "ph_low",
      message: `pH thấp bất thường: ${ph}, thấp hơn ngưỡng ${threshold.ph_min}`,
      current_value: ph,
      threshold_value: threshold.ph_min,
      severity: "high",
    });
  }

  if (waterLevel !== null && waterLevel < threshold.water_level_min) {
    alerts.push({
      alert_type: "water_level_low",
      message: `Mực nước thấp: ${waterLevel}%, thấp hơn ngưỡng ${threshold.water_level_min}%`,
      current_value: waterLevel,
      threshold_value: threshold.water_level_min,
      severity: "high",
    });
  }

  if (battery !== null && battery < threshold.battery_min) {
    alerts.push({
      alert_type: "battery_low",
      message: `Pin thiết bị yếu: ${battery}%, thấp hơn ngưỡng ${threshold.battery_min}%`,
      current_value: battery,
      threshold_value: threshold.battery_min,
      severity: "medium",
    });
  }

  if (rssi !== null && rssi < threshold.rssi_min) {
    alerts.push({
      alert_type: "rssi_low",
      message: `Tín hiệu WiFi yếu: ${rssi} dBm, thấp hơn ngưỡng ${threshold.rssi_min} dBm`,
      current_value: rssi,
      threshold_value: threshold.rssi_min,
      severity: "medium",
    });
  }

  return alerts;
}

async function shouldSkipDuplicateAlert(tankId, deviceId, alertType) {
  const [rows] = await db.query(
    `SELECT id
     FROM alerts
     WHERE tank_id = ?
       AND device_id = ?
       AND alert_type = ?
       AND status = 'new'
       AND created_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
     LIMIT 1`,
    [tankId, deviceId, alertType]
  );

  return rows.length > 0;
}

function validateDeviceToken(payload, source = "MQTT") {
  const expectedDeviceToken = process.env.DEVICE_MQTT_TOKEN;

  if (!expectedDeviceToken) {
    return true;
  }

  const incomingDeviceToken = String(payload.device_token || "");

  if (incomingDeviceToken !== expectedDeviceToken) {
    console.log(`❌ ${source} bị từ chối: device_token không hợp lệ`);
    return false;
  }

  delete payload.device_token;

  return true;
}

function parseModuleConfigJson(value) {
  if (!value) return {};

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function publishMqtt(topic, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const message = JSON.stringify(payload);

    mqttClient.publish(
      topic,
      message,
      {
        qos: options.qos ?? 1,
        retain: options.retain ?? true,
      },
      (err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve({
          ok: true,
          topic,
          payload,
        });
      }
    );
  });
}

async function getDeviceConfigPayload(deviceId, meta = {}) {
  const [[device]] = await db.query(
    `SELECT
      d.id AS device_id,
      d.tank_id,
      d.device_code,
      d.name AS device_name,
      d.status AS device_status,
      t.user_id AS owner_id,
      t.name AS tank_name,
      t.tank_code,
      t.status AS tank_status
     FROM devices d
     LEFT JOIN tanks t ON d.tank_id = t.id
     WHERE d.id = ?`,
    [deviceId]
  );

  if (!device) {
    throw new Error(`Không tìm thấy device_id ${deviceId}`);
  }

  const [moduleRows] = await db.query(
    `SELECT
      id,
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
      updated_at
     FROM device_modules
     WHERE device_id = ?
     ORDER BY id ASC`,
    [deviceId]
  );

  const modules = moduleRows.map((module) => ({
    id: module.id,
    module_code: module.module_code,
    name: module.name,
    connection_type: module.connection_type,
    io_mode: module.io_mode,
    module_type: module.module_type,
    pin: module.pin,
    pin2: module.pin2,
    pin3: module.pin3,
    unit: module.unit,
    protocol: module.protocol,
    node_type: module.node_type,
    node_code: module.node_code,
    enabled: Boolean(module.enabled),
    config: parseModuleConfigJson(module.config_json),
    updated_at: module.updated_at,
  }));

  const topic = `aquarium/${device.owner_id}/${device.tank_id}/config`;

  const payload = {
    type: "config_update",
    version: 1,
    reason: meta.reason || "manual_publish",
    changed_module_id: meta.changed_module_id || null,
    device_id: device.device_id,
    device_code: device.device_code,
    tank_id: device.tank_id,
    owner_id: device.owner_id,
    timestamp: new Date().toISOString(),
    modules,
  };

  return {
    topic,
    payload,
    device,
  };
}

async function publishDeviceConfig(deviceId, meta = {}) {
  const { topic, payload, device } = await getDeviceConfigPayload(deviceId, meta);

  console.log("");
  console.log("📤 Publish device config");
  console.log("Topic:", topic);
  console.log("Device:", device.device_code);
  console.log("Modules:", payload.modules.length);

  const result = await publishMqtt(topic, payload, {
    qos: 1,
    retain: true,
  });

  console.log("✅ Publish device config OK");

  return result;
}

async function handleConfigAck(io, topic, payload) {
  const parts = topic.split("/");

  if (
    parts.length !== 4 ||
    parts[0] !== "aquarium" ||
    parts[3] !== "config_ack"
  ) {
    console.log("❌ Topic config_ack không đúng định dạng");
    return;
  }

  if (!validateDeviceToken(payload, "MQTT config_ack")) {
    return;
  }

  const userId = Number(parts[1]);
  const tankId = Number(parts[2]);
  const deviceId = Number(payload.device_id);

  if (!userId || !tankId || !deviceId) {
    console.log("❌ config_ack thiếu userId, tankId hoặc device_id");
    return;
  }

  const [[tank]] = await db.query(
    `SELECT id, user_id, status AS tank_status
     FROM tanks
     WHERE id = ? AND user_id = ?`,
    [tankId, userId]
  );

  if (!tank) {
    console.log("❌ config_ack: không tìm thấy bể hoặc bể không thuộc user");
    return;
  }

  const [[device]] = await db.query(
    `SELECT id, status
     FROM devices
     WHERE id = ? AND tank_id = ?`,
    [deviceId, tankId]
  );

  if (!device) {
    console.log("❌ config_ack: không tìm thấy thiết bị hoặc thiết bị không thuộc bể");
    return;
  }

  const ackPayload = {
    userId,
    tankId,
    deviceId,
    status: payload.status || "unknown",
    message: payload.message || "",
    module_count:
      payload.module_count !== undefined ? Number(payload.module_count) : null,
    millis: payload.millis || null,
    timestamp: new Date().toISOString(),
  };

  await db.query(
    `UPDATE devices
     SET last_seen = NOW()
     WHERE id = ?`,
    [deviceId]
  );

  io.to(`user_${userId}`).emit("config_ack", ackPayload);
  io.to("managers").emit("config_ack", ackPayload);

  console.log("✅ Đã nhận config_ack từ ESP:");
  console.log(ackPayload);
}

const initMQTT = (io) => {
  mqttClient.on("message", async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      console.log(`📥 Nhận từ topic ${topic}:`, payload);

      const parts = topic.split("/");

if (
  parts.length === 4 &&
  parts[0] === "aquarium" &&
  parts[3] === "config_ack"
) {
  await handleConfigAck(io, topic, payload);
  return;
}

// Topic chuẩn:
// aquarium/{user_id}/{tank_id}/sensor
if (
  parts.length !== 4 ||
  parts[0] !== "aquarium" ||
  parts[3] !== "sensor"
) {
        console.log(
          "❌ Topic không đúng định dạng aquarium/{user_id}/{tank_id}/sensor"
        );
        return;
      }

      if (!validateDeviceToken(payload, "MQTT sensor")) {
  return;
}

      const userId = Number(parts[1]);
      const tankId = Number(parts[2]);
      const deviceId = Number(payload.device_id);

      if (!userId || !tankId || !deviceId) {
        console.log("❌ Thiếu userId, tankId hoặc device_id");
        return;
      }

      // Kiểm tra bể có thuộc user không + lấy gói user
      const [[tank]] = await db.query(
        `SELECT
          t.id,
          t.user_id,
          t.status AS tank_status,
          u.email,
          u.plan_type,
          u.plan_expires_at
         FROM tanks t
         LEFT JOIN users u ON t.user_id = u.id
         WHERE t.id = ? AND t.user_id = ?`,
        [tankId, userId]
      );

      if (!tank) {
        console.log("❌ Không tìm thấy bể hoặc bể không thuộc user");
        return;
      }

      // Kiểm tra device có thuộc đúng bể không
      const [[device]] = await db.query(
        `SELECT id, status
         FROM devices
         WHERE id = ? AND tank_id = ?`,
        [deviceId, tankId]
      );

      if (!device) {
        console.log("❌ Không tìm thấy thiết bị hoặc thiết bị không thuộc bể");
        return;
      }

      if (tank.tank_status === "suspended" || device.status === "suspended") {
        console.log("⚠️ Bể hoặc thiết bị đang bị tạm khóa, bỏ qua dữ liệu MQTT");
        return;
      }

      const temperature =
        payload.temperature !== undefined ? Number(payload.temperature) : null;
      const ph = payload.ph !== undefined ? Number(payload.ph) : null;
      const waterLevel =
        payload.water_level !== undefined ? Number(payload.water_level) : null;
      const battery =
        payload.battery !== undefined ? Number(payload.battery) : null;
      const rssi = payload.rssi !== undefined ? Number(payload.rssi) : null;

      const waterLevelSource =
        payload.water_level_source !== undefined
          ? String(payload.water_level_source)
          : null;

      const distanceCm =
        payload.distance_cm !== undefined ? Number(payload.distance_cm) : null;

      const waterDistanceCm =
        payload.water_distance_cm !== undefined
          ? Number(payload.water_distance_cm)
          : distanceCm;

      const waterLevelCm =
        payload.water_level_cm !== undefined ? Number(payload.water_level_cm) : null;

      const waterEmptyDistanceCm =
        payload.water_empty_distance_cm !== undefined
          ? Number(payload.water_empty_distance_cm)
          : null;

      const wirelessNodeCode =
        payload.wireless_node_code !== undefined
          ? String(payload.wireless_node_code)
          : null;

      const wirelessModuleType =
        payload.module_type !== undefined ? String(payload.module_type) : null;

      const waterWirelessSeq =
        payload.water_wireless_seq !== undefined
          ? Number(payload.water_wireless_seq)
          : null;

      const waterWirelessAgeMs =
        payload.water_wireless_age_ms !== undefined
          ? Number(payload.water_wireless_age_ms)
          : null;

      const waterWirelessNodeUptimeMs =
        payload.water_wireless_node_uptime_ms !== undefined
          ? Number(payload.water_wireless_node_uptime_ms)
          : null;

      const wirelessNodeOnline =
        waterLevelSource === "esp_now_hc_sr04" &&
        waterWirelessAgeMs !== null &&
        waterWirelessAgeMs <= 15000;

      // Lưu sensor data vào DB
      const [result] = await db.query(
        `INSERT INTO sensor_data
         (device_id, temperature, ph, water_level, battery, rssi)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [deviceId, temperature, ph, waterLevel, battery, rssi]
      );

      // Cập nhật trạng thái thiết bị
      await db.query(
        `UPDATE devices
         SET last_seen = NOW(), battery_level = ?, rssi = ?
         WHERE id = ?`,
        [battery, rssi, deviceId]
      );

      console.log("✅ Đã lưu sensor data, ID:", result.insertId);

      const threshold = await getThreshold(tankId);

      const alertList = buildAlerts(
        {
          temperature,
          ph,
          water_level: waterLevel,
          battery,
          rssi,
        },
        threshold
      );

      const plan = getEffectivePlan(tank);

      const canSaveAlertHistory =
        SAVE_ALERT_HISTORY_FOR_BASIC || plan.effective_plan === "premium";

      const savedAlerts = [];

      for (const alert of alertList) {
        const skipDuplicate = await shouldSkipDuplicateAlert(
          tankId,
          deviceId,
          alert.alert_type
        );

        if (skipDuplicate) {
          console.log(`⚠️ Bỏ qua alert trùng gần đây: ${alert.alert_type}`);
          continue;
        }

        if (canSaveAlertHistory) {
          const [alertResult] = await db.query(
            `INSERT INTO alerts
             (tank_id, device_id, message, alert_type, current_value, threshold_value, severity, is_read, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'new')`,
            [
              tankId,
              deviceId,
              alert.message,
              alert.alert_type,
              alert.current_value,
              alert.threshold_value,
              alert.severity,
            ]
          );

          savedAlerts.push({
            id: alertResult.insertId,
            ...alert,
          });

          console.log(`🚨 Đã lưu alert: ${alert.message}`);
        } else {
          console.log(
            `🚨 Alert realtime không lưu lịch sử do Basic: ${alert.message}`
          );
        }
      }

      // Dữ liệu realtime gửi cho frontend
      const realtimeData = {
        userId,
        tankId,
        deviceId,
        data: {
          device_id: deviceId,
          temperature,
          ph,
          water_level: waterLevel,
          water_level_source: waterLevelSource,
          distance_cm: distanceCm,
          water_distance_cm: waterDistanceCm,
          water_level_cm: waterLevelCm,
          water_empty_distance_cm: waterEmptyDistanceCm,
          wireless_node_code: wirelessNodeCode,
          wireless_module_type: wirelessModuleType,
          water_wireless_seq: waterWirelessSeq,
          water_wireless_age_ms: waterWirelessAgeMs,
          water_wireless_node_uptime_ms: waterWirelessNodeUptimeMs,
          wireless_node_online: wirelessNodeOnline,
          battery,
          rssi,
        },
        threshold,
        alerts: alertList,
        saved_alerts: savedAlerts,
        timestamp: new Date().toISOString(),
      };

      // Gửi realtime cho chủ bể
      io.to(`user_${userId}`).emit("sensor_update", realtimeData);

      // Gửi realtime cho admin/moderator
      io.to("managers").emit("sensor_update", realtimeData);

      console.log(
        `✅ Đã push realtime sensor_update cho user_${userId} và managers - tank ${tankId} - device ${deviceId}`
      );

      // Push alert realtime nếu có bất thường
      // Lưu ý: dù alert bị bỏ qua lưu DB do trùng gần đây, realtime vẫn gửi để demo chuông.
      if (alertList.length > 0) {
        for (const alert of alertList) {
          const alertPayload = {
            userId,
            tankId,
            deviceId,
            message: alert.message,
            alert_type: alert.alert_type,
            current_value: alert.current_value,
            threshold_value: alert.threshold_value,
            severity: alert.severity,
            timestamp: new Date().toISOString(),
          };

          io.to(`user_${userId}`).emit("alert", alertPayload);
          io.to("managers").emit("alert", alertPayload);
        }

        console.log(
          `🔔 Đã push ${alertList.length} alert realtime cho user_${userId} và managers`
        );
      }
    } catch (err) {
      console.error("MQTT message error:", err);
    }
  });
};

module.exports = {
  initMQTT,
  publishDeviceConfig,
};