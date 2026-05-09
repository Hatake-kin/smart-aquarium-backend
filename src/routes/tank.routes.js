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
    return res.status(401).json({
      message: "Thiếu token đăng nhập",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      message: "Token không hợp lệ",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      message: "Token hết hạn hoặc không hợp lệ",
    });
  }
}

function generateTankCode() {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `TANK${random}`;
}

function isManager(role) {
  return role === "admin" || role === "moderator";
}

function isAdmin(role) {
  return role === "admin";
}

async function getEffectivePlan(userId) {
  const [rows] = await db.query(
    `SELECT plan_type, plan_expires_at
     FROM users
     WHERE id = ?`,
    [userId]
  );

  if (rows.length === 0) {
    return {
      plan_type: "basic",
      plan_expires_at: null,
      effective_plan: "basic",
      is_premium_active: false,
      is_premium_expired: false,
    };
  }

  const user = rows[0];

  const isPremium = user.plan_type === "premium";

  const isExpired =
    isPremium &&
    user.plan_expires_at &&
    new Date(user.plan_expires_at).getTime() < Date.now();

  const isPremiumActive = isPremium && !isExpired;

  return {
    plan_type: user.plan_type || "basic",
    plan_expires_at: user.plan_expires_at,
    effective_plan: isPremiumActive ? "premium" : "basic",
    is_premium_active: isPremiumActive,
    is_premium_expired: Boolean(isExpired),
  };
}

function buildInClause(values) {
  return values.map(() => "?").join(",");
}

async function tableExists(tableName) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [tableName]
  );

  return Number(rows[0]?.count || 0) > 0;
}

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?`,
    [tableName, columnName]
  );

  return Number(rows[0]?.count || 0) > 0;
}

async function getTankWithOwner(tankId) {
  const [[tank]] = await db.query(
    `SELECT
      t.id,
      t.user_id,
      t.tank_code,
      t.name,
      t.package_type,
      t.status,
      t.created_at,
      t.updated_at,
      u.email AS owner_email,
      u.full_name AS owner_full_name,
      u.role AS owner_role
     FROM tanks t
     LEFT JOIN users u ON t.user_id = u.id
     WHERE t.id = ?`,
    [tankId]
  );

  return tank || null;
}

function canDeleteTank(tank, user) {
  if (!tank || !user) return false;
  if (isAdmin(user.role)) return true;
  return Number(tank.user_id) === Number(user.id);
}

function getPermissionNote(tank, user) {
  if (isAdmin(user.role)) {
    if (Number(tank.user_id) === Number(user.id)) {
      return "Bạn là admin và cũng là chủ bể này.";
    }

    return `Bạn là admin nên có quyền xóa bể của ${tank.owner_email || tank.user_id}.`;
  }

  if (Number(tank.user_id) === Number(user.id)) {
    return "Bạn là chủ bể nên có quyền xóa bể này.";
  }

  return "Bạn không có quyền xóa bể này.";
}

async function getOptionalGroupedRows(tableName, tankId, deviceIds) {
  const exists = await tableExists(tableName);

  if (!exists) {
    return {
      table_exists: false,
      count: 0,
      details: [],
    };
  }

  const hasTankId = await columnExists(tableName, "tank_id");
  const hasDeviceId = await columnExists(tableName, "device_id");

  if (hasTankId) {
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS count FROM ${tableName} WHERE tank_id = ?`,
      [tankId]
    );

    const [details] = await db.query(
      `SELECT *
       FROM ${tableName}
       WHERE tank_id = ?
       ORDER BY id DESC
       LIMIT 20`,
      [tankId]
    );

    return {
      table_exists: true,
      count: Number(countRows[0]?.count || 0),
      details,
    };
  }

  if (hasDeviceId && deviceIds.length > 0) {
    const placeholders = buildInClause(deviceIds);

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS count
       FROM ${tableName}
       WHERE device_id IN (${placeholders})`,
      deviceIds
    );

    const [details] = await db.query(
      `SELECT *
       FROM ${tableName}
       WHERE device_id IN (${placeholders})
       ORDER BY id DESC
       LIMIT 20`,
      deviceIds
    );

    return {
      table_exists: true,
      count: Number(countRows[0]?.count || 0),
      details,
    };
  }

  return {
    table_exists: true,
    count: 0,
    details: [],
  };
}

async function buildDeletePreview(tankId, reqUser) {
  const tank = await getTankWithOwner(tankId);

  if (!tank) {
    return {
      status: 404,
      body: {
        message: "Không tìm thấy bể cá",
      },
    };
  }

  if (!canDeleteTank(tank, reqUser)) {
    return {
      status: 403,
      body: {
        message: "Bạn không có quyền xóa bể cá này",
      },
    };
  }

  const [devices] = await db.query(
    `SELECT
      id,
      tank_id,
      device_code,
      name,
      status,
      last_seen,
      battery_level,
      rssi,
      created_at,
      updated_at
     FROM devices
     WHERE tank_id = ?
     ORDER BY id ASC`,
    [tankId]
  );

  const deviceIds = devices.map((device) => Number(device.id));

  let sensorDataByDevice = [];
  let actuatorStates = [];
  let alertsByDevice = [];
  let alertsByType = [];
  let latestAlerts = [];
  let thresholds = [];

  if (deviceIds.length > 0) {
    const placeholders = buildInClause(deviceIds);

    [sensorDataByDevice] = await db.query(
      `SELECT
        d.id AS device_id,
        d.name AS device_name,
        d.device_code,
        COUNT(sd.id) AS count,
        MIN(sd.created_at) AS first_created_at,
        MAX(sd.created_at) AS last_created_at
       FROM devices d
       LEFT JOIN sensor_data sd ON sd.device_id = d.id
       WHERE d.id IN (${placeholders})
       GROUP BY d.id, d.name, d.device_code
       ORDER BY d.id ASC`,
      deviceIds
    );

    [actuatorStates] = await db.query(
      `SELECT
        a.id,
        a.device_id,
        d.name AS device_name,
        d.device_code,
        a.pump,
        a.light,
        a.oxygen,
        a.auto_mode,
        a.last_command_by,
        a.last_command_at,
        a.updated_at
       FROM actuator_states a
       LEFT JOIN devices d ON a.device_id = d.id
       WHERE a.device_id IN (${placeholders})
       ORDER BY a.id ASC`,
      deviceIds
    );

    [alertsByDevice] = await db.query(
      `SELECT
        device_id,
        COUNT(*) AS count
       FROM alerts
       WHERE tank_id = ?
       GROUP BY device_id`,
      [tankId]
    );
  }

  [alertsByType] = await db.query(
    `SELECT
      alert_type,
      severity,
      COUNT(*) AS count
     FROM alerts
     WHERE tank_id = ?
     GROUP BY alert_type, severity
     ORDER BY count DESC`,
    [tankId]
  );

  [latestAlerts] = await db.query(
    `SELECT
      id,
      device_id,
      alert_type,
      message,
      severity,
      status,
      created_at
     FROM alerts
     WHERE tank_id = ?
     ORDER BY created_at DESC
     LIMIT 5`,
    [tankId]
  );

  [thresholds] = await db.query(
    `SELECT *
     FROM alert_thresholds
     WHERE tank_id = ?`,
    [tankId]
  );

  const cameraSnapshots = await getOptionalGroupedRows(
    "camera_snapshots",
    tankId,
    deviceIds
  );

  const deviceModules = await getOptionalGroupedRows(
    "device_modules",
    tankId,
    deviceIds
  );

  const sensorDataTotal = sensorDataByDevice.reduce(
    (sum, row) => sum + Number(row.count || 0),
    0
  );

  const alertTotal = alertsByType.reduce(
    (sum, row) => sum + Number(row.count || 0),
    0
  );

  const alertCountByDevice = new Map(
    alertsByDevice.map((row) => [Number(row.device_id), Number(row.count || 0)])
  );

  const sensorInfoByDevice = new Map(
    sensorDataByDevice.map((row) => [Number(row.device_id), row])
  );

  const actuatorCountByDevice = new Map();

  for (const state of actuatorStates) {
    const deviceId = Number(state.device_id);
    actuatorCountByDevice.set(
      deviceId,
      Number(actuatorCountByDevice.get(deviceId) || 0) + 1
    );
  }

  const deviceDetails = devices.map((device) => {
    const sensorInfo = sensorInfoByDevice.get(Number(device.id));

    return {
      ...device,
      sensor_data_count: Number(sensorInfo?.count || 0),
      sensor_first_created_at: sensorInfo?.first_created_at || null,
      sensor_last_created_at: sensorInfo?.last_created_at || null,
      actuator_state_count: Number(
        actuatorCountByDevice.get(Number(device.id)) || 0
      ),
      alert_count: Number(alertCountByDevice.get(Number(device.id)) || 0),
    };
  });

  return {
    status: 200,
    body: {
      message: "Lấy preview xóa bể cá thành công",
      tank: {
        id: tank.id,
        user_id: tank.user_id,
        tank_code: tank.tank_code,
        name: tank.name,
        package_type: tank.package_type,
        status: tank.status,
        created_at: tank.created_at,
        updated_at: tank.updated_at,
        owner: {
          id: tank.user_id,
          email: tank.owner_email,
          full_name: tank.owner_full_name,
          role: tank.owner_role,
        },
      },
      can_delete: true,
      permission_note: getPermissionNote(tank, reqUser),
      summary: {
        devices: devices.length,
        sensor_data: sensorDataTotal,
        actuator_states: actuatorStates.length,
        alerts: alertTotal,
        alert_thresholds: thresholds.length,
        camera_snapshots: cameraSnapshots.count,
        device_modules: deviceModules.count,
      },
      details: {
        devices: deviceDetails,
        sensor_data_by_device: sensorDataByDevice,
        actuator_states: actuatorStates,
        alerts_by_type: alertsByType,
        latest_alerts: latestAlerts,
        thresholds,
        camera_snapshots: cameraSnapshots,
        device_modules: deviceModules,
      },
    },
  };
}

async function deleteOptionalRows(connection, tableName, tankId, deviceIds) {
  const exists = await tableExists(tableName);

  if (!exists) return 0;

  const hasTankId = await columnExists(tableName, "tank_id");
  const hasDeviceId = await columnExists(tableName, "device_id");

  if (hasTankId) {
    const [result] = await connection.query(
      `DELETE FROM ${tableName} WHERE tank_id = ?`,
      [tankId]
    );

    return Number(result.affectedRows || 0);
  }

  if (hasDeviceId && deviceIds.length > 0) {
    const placeholders = buildInClause(deviceIds);

    const [result] = await connection.query(
      `DELETE FROM ${tableName} WHERE device_id IN (${placeholders})`,
      deviceIds
    );

    return Number(result.affectedRows || 0);
  }

  return 0;
}

// ===============================
// LẤY DANH SÁCH BỂ CÁ
// ===============================
router.get("/", authMiddleware, async (req, res) => {
  try {
    let rows;

    if (isManager(req.user.role)) {
      [rows] = await db.query(
        `SELECT 
          t.id,
          t.user_id,
          t.tank_code,
          t.name,
          t.package_type,
          t.status,
          t.created_at,
          t.updated_at,
          u.email,
          u.full_name,
          u.plan_type,
          u.plan_expires_at
        FROM tanks t
        LEFT JOIN users u ON t.user_id = u.id
        ORDER BY t.id DESC`
      );
    } else {
      [rows] = await db.query(
        `SELECT 
          t.id,
          t.user_id,
          t.tank_code,
          t.name,
          t.package_type,
          t.status,
          t.created_at,
          t.updated_at,
          u.plan_type,
          u.plan_expires_at
        FROM tanks t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.user_id = ?
        ORDER BY t.id DESC`,
        [req.user.id]
      );
    }

    const tanks = rows.map((tank, index) => {
      const isPremium =
        tank.plan_type === "premium" &&
        (!tank.plan_expires_at ||
          new Date(tank.plan_expires_at).getTime() >= Date.now());

      const effectivePlan = isPremium ? "premium" : "basic";

      const overBasicLimit =
        !isManager(req.user.role) && effectivePlan === "basic" && index >= 1;

      return {
        ...tank,
        effective_plan: effectivePlan,
        is_premium_expired:
          tank.plan_type === "premium" &&
          tank.plan_expires_at &&
          new Date(tank.plan_expires_at).getTime() < Date.now(),
        access_status: overBasicLimit ? "suspended_by_plan" : tank.status,
      };
    });

    res.json({
      message: "Lấy danh sách bể cá thành công",
      tanks,
    });
  } catch (err) {
    console.error("Get tanks error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy danh sách bể cá",
    });
  }
});

// ===============================
// PREVIEW XÓA BỂ CÁ
// ===============================
router.get("/:tankId/delete-preview", authMiddleware, async (req, res) => {
  try {
    const tankId = Number(req.params.tankId);

    if (!tankId) {
      return res.status(400).json({
        message: "Thiếu tank_id",
      });
    }

    if (req.user.role === "moderator") {
      return res.status(403).json({
        message: "Moderator chỉ được xem, không được xóa bể cá",
      });
    }

    const preview = await buildDeletePreview(tankId, req.user);

    return res.status(preview.status).json(preview.body);
  } catch (err) {
    console.error("Delete tank preview error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy preview xóa bể cá",
    });
  }
});

// ===============================
// TẠO BỂ CÁ MỚI
// ===============================
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { name, package_type } = req.body;
    const requestInfo = getRequestInfo(req);

    if (!name || !name.trim()) {
      await createSystemLog({
        user_id: req.user.id,
        action: "create_tank_failed_missing_name",
        entity_type: "tank",
        entity_id: null,
        description: `Người dùng ${req.user.email} tạo bể thất bại: thiếu tên bể cá`,
        ...requestInfo,
      });

      return res.status(400).json({
        message: "Thiếu tên bể cá",
      });
    }

    let finalPackageType = "basic";

    if (req.user.role === "admin") {
      const validPackages = ["basic", "premium"];

      finalPackageType = validPackages.includes(package_type)
        ? package_type
        : "basic";
    }

    if (!isManager(req.user.role)) {
      const plan = await getEffectivePlan(req.user.id);

      if (plan.effective_plan === "basic") {
        const [existingTanks] = await db.query(
          "SELECT id FROM tanks WHERE user_id = ?",
          [req.user.id]
        );

        if (existingTanks.length >= 1) {
          await createSystemLog({
            user_id: req.user.id,
            action: plan.is_premium_expired
              ? "create_tank_failed_premium_expired"
              : "create_tank_failed_basic_limit",
            entity_type: "tank",
            entity_id: null,
            description: plan.is_premium_expired
              ? `Người dùng ${req.user.email} tạo bể "${name.trim()}" thất bại: Premium đã hết hạn, áp dụng giới hạn Basic tối đa 1 bể`
              : `Người dùng ${req.user.email} tạo bể "${name.trim()}" thất bại: gói Basic chỉ cho phép tối đa 1 bể`,
            ...requestInfo,
          });

          return res.status(403).json({
            message: plan.is_premium_expired
              ? "Gói Premium đã hết hạn. Tài khoản hiện được áp dụng giới hạn Basic: tối đa 1 bể cá. Vui lòng liên hệ admin để gia hạn Premium."
              : "Gói Basic chỉ cho phép tạo tối đa 1 bể cá. Vui lòng liên hệ admin để nâng cấp Premium.",
          });
        }

        finalPackageType = "basic";
      }

      if (plan.effective_plan === "premium") {
        finalPackageType = "premium";
      }
    }

    if (req.user.role === "moderator") {
      finalPackageType = "basic";
    }

    let tankCode = generateTankCode();

    let duplicated = true;

    while (duplicated) {
      const [exists] = await db.query(
        "SELECT id FROM tanks WHERE tank_code = ?",
        [tankCode]
      );

      if (exists.length === 0) {
        duplicated = false;
      } else {
        tankCode = generateTankCode();
      }
    }

    const [result] = await db.query(
      `INSERT INTO tanks 
       (user_id, tank_code, name, package_type, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [req.user.id, tankCode, name.trim(), finalPackageType]
    );

    await createSystemLog({
      user_id: req.user.id,
      action: "create_tank_success",
      entity_type: "tank",
      entity_id: result.insertId,
      description: `Người dùng ${req.user.email} đã tạo bể cá "${name.trim()}" với mã ${tankCode}, gói ${finalPackageType}`,
      ...requestInfo,
    });

    res.json({
      message: "Tạo bể cá thành công",
      tank: {
        id: result.insertId,
        user_id: req.user.id,
        tank_code: tankCode,
        name: name.trim(),
        package_type: finalPackageType,
        status: "active",
      },
    });
  } catch (err) {
    console.error("Create tank error:", err);
    res.status(500).json({
      message: "Lỗi server khi tạo bể cá",
    });
  }
});

// ===============================
// XÓA BỂ CÁ
// ===============================
router.delete("/:tankId", authMiddleware, async (req, res) => {
  let connection;

  try {
    const tankId = Number(req.params.tankId);
    const requestInfo = getRequestInfo(req);

    if (!tankId) {
      return res.status(400).json({
        message: "Thiếu tank_id",
      });
    }

    if (req.user.role === "moderator") {
      return res.status(403).json({
        message: "Moderator chỉ được xem, không được xóa bể cá",
      });
    }

    const preview = await buildDeletePreview(tankId, req.user);

    if (preview.status !== 200) {
      return res.status(preview.status).json(preview.body);
    }

    const tank = preview.body.tank;
    const [deviceRows] = await db.query(
      `SELECT id FROM devices WHERE tank_id = ?`,
      [tankId]
    );

    const deviceIds = deviceRows.map((row) => Number(row.id));

    if (typeof db.getConnection === "function") {
      connection = await db.getConnection();
    } else {
      connection = db;
    }

    await connection.beginTransaction();

    const deleted = {
      device_modules: await deleteOptionalRows(
        connection,
        "device_modules",
        tankId,
        deviceIds
      ),
      camera_snapshots: await deleteOptionalRows(
        connection,
        "camera_snapshots",
        tankId,
        deviceIds
      ),
      sensor_data: 0,
      actuator_states: 0,
      alerts: 0,
      alert_thresholds: 0,
      devices: 0,
      tanks: 0,
    };

    if (deviceIds.length > 0) {
      const placeholders = buildInClause(deviceIds);

      const [sensorResult] = await connection.query(
        `DELETE FROM sensor_data WHERE device_id IN (${placeholders})`,
        deviceIds
      );
      deleted.sensor_data = Number(sensorResult.affectedRows || 0);

      const [actuatorResult] = await connection.query(
        `DELETE FROM actuator_states WHERE device_id IN (${placeholders})`,
        deviceIds
      );
      deleted.actuator_states = Number(actuatorResult.affectedRows || 0);
    }

    const [alertsResult] = await connection.query(
      `DELETE FROM alerts WHERE tank_id = ?`,
      [tankId]
    );
    deleted.alerts = Number(alertsResult.affectedRows || 0);

    const [thresholdResult] = await connection.query(
      `DELETE FROM alert_thresholds WHERE tank_id = ?`,
      [tankId]
    );
    deleted.alert_thresholds = Number(thresholdResult.affectedRows || 0);

    const [devicesResult] = await connection.query(
      `DELETE FROM devices WHERE tank_id = ?`,
      [tankId]
    );
    deleted.devices = Number(devicesResult.affectedRows || 0);

    const [tankResult] = await connection.query(
      `DELETE FROM tanks WHERE id = ?`,
      [tankId]
    );
    deleted.tanks = Number(tankResult.affectedRows || 0);

    await connection.commit();

    try {
      await createSystemLog({
        user_id: req.user.id,
        action: "delete_tank_success",
        entity_type: "tank",
        entity_id: tankId,
        description:
          `Người dùng ${req.user.email} đã xóa bể "${tank.name}" ` +
          `của ${tank.owner?.email || tank.user_id}. ` +
          `Đã xóa: devices=${deleted.devices}, sensor_data=${deleted.sensor_data}, ` +
          `actuator_states=${deleted.actuator_states}, alerts=${deleted.alerts}, ` +
          `thresholds=${deleted.alert_thresholds}, snapshots=${deleted.camera_snapshots}, modules=${deleted.device_modules}`,
        ...requestInfo,
      });
    } catch (logErr) {
      console.error("Create delete tank system log error:", logErr);
    }

    res.json({
      message: "Xóa bể cá thành công",
      deleted,
      tank,
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("Rollback delete tank error:", rollbackErr);
      }
    }

    console.error("Delete tank error:", err);

    res.status(500).json({
      message: "Lỗi server khi xóa bể cá",
    });
  } finally {
    if (connection && typeof connection.release === "function") {
      connection.release();
    }
  }
});

module.exports = router;