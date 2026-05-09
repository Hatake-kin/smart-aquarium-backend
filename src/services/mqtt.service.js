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

function validateDeviceToken(payload) {
  const expectedDeviceToken = process.env.DEVICE_MQTT_TOKEN;

  // Nếu chưa cấu hình DEVICE_MQTT_TOKEN thì giữ chế độ cũ để không làm hỏng demo.
  if (!expectedDeviceToken) {
    return true;
  }

  const incomingDeviceToken = String(payload.device_token || "");

  if (incomingDeviceToken !== expectedDeviceToken) {
    console.log("❌ MQTT sensor bị từ chối: device_token không hợp lệ");
    return false;
  }

  // Không lưu token vào DB / không đẩy realtime token ra frontend.
  delete payload.device_token;

  return true;
}

const initMQTT = (io) => {
  mqttClient.on("message", async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      console.log(`📥 Nhận từ topic ${topic}:`, payload);

      const parts = topic.split("/");

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

      if (!validateDeviceToken(payload)) {
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

module.exports = { initMQTT };