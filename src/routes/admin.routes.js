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

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({
      message: "Bạn không có quyền admin để thực hiện chức năng này",
    });
  }

  next();
}

function managerOnly(req, res, next) {
  if (req.user.role !== "admin" && req.user.role !== "moderator") {
    return res.status(403).json({
      message: "Bạn không có quyền quản lý người dùng",
    });
  }

  next();
}

// Admin + Moderator xem danh sách user
// Admin + Moderator xem danh sách user
router.get("/users", authMiddleware, managerOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
        id,
        email,
        full_name,
        phone,
        role,
        plan_type,
        plan_expires_at,
        is_active,
        last_login,
        created_at,
        CASE
          WHEN is_active = 0 THEN 'locked'
          WHEN last_login IS NULL THEN 'offline'
          WHEN TIMESTAMPDIFF(MINUTE, last_login, UTC_TIMESTAMP()) <= 15 THEN 'active'
          ELSE 'offline'
        END AS computed_status,
        CASE
          WHEN is_active = 0 THEN 'Bị khóa'
          WHEN last_login IS NULL THEN 'Ngoại tuyến'
          WHEN TIMESTAMPDIFF(MINUTE, last_login, UTC_TIMESTAMP()) <= 15 THEN 'Đang hoạt động'
          ELSE 'Ngoại tuyến'
        END AS status_label
       FROM users
       ORDER BY id DESC`
    );

    res.json({
      message: "Lấy danh sách người dùng thành công",
      users: rows,
      status_rule: {
        active_window_minutes: 15,
        active: "Đăng nhập trong 15 phút gần nhất",
        offline: "Quá 15 phút hoặc chưa từng đăng nhập",
        locked: "Tài khoản bị khóa",
      },
    });
  } catch (err) {
    console.error("Admin get users error:", err);
    res.status(500).json({ message: "Lỗi server khi lấy danh sách user" });
  }
});

// Chỉ Admin được đổi role
router.patch("/users/:id/role", authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body;
    const requestInfo = getRequestInfo(req);

    const validRoles = ["user", "admin", "moderator"];

    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Role không hợp lệ" });
    }

    if (userId === req.user.id) {
      return res.status(403).json({
        message: "Không thể tự đổi quyền của chính mình",
      });
    }

    const [targetRows] = await db.query(
      "SELECT id, email, role FROM users WHERE id = ?",
      [userId]
    );

    if (targetRows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy tài khoản",
      });
    }

    const targetUser = targetRows[0];
    const oldRole = targetUser.role;

    await db.query("UPDATE users SET role = ? WHERE id = ?", [role, userId]);

    await createSystemLog({
      user_id: req.user.id,
      action: "admin_change_role",
      entity_type: "user",
      entity_id: userId,
      description: `Admin ${req.user.email} đổi role tài khoản ${targetUser.email} từ ${oldRole} sang ${role}`,
      ...requestInfo,
    });

    res.json({
      message: "Cập nhật quyền người dùng thành công",
    });
  } catch (err) {
    console.error("Admin update role error:", err);
    res.status(500).json({ message: "Lỗi server khi cập nhật role" });
  }
});

// Admin + Moderator khóa/mở tài khoản
// Moderator chỉ được khóa/mở user thường
router.patch(
  "/users/:id/status",
  authMiddleware,
  managerOnly,
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const { is_active } = req.body;
      const requestInfo = getRequestInfo(req);

      if (userId === req.user.id) {
        return res.status(403).json({
          message: "Không thể khóa/mở chính tài khoản đang đăng nhập",
        });
      }

      const [targetRows] = await db.query(
        "SELECT id, email, role, is_active FROM users WHERE id = ?",
        [userId]
      );

      if (targetRows.length === 0) {
        return res.status(404).json({
          message: "Không tìm thấy tài khoản",
        });
      }

      const targetUser = targetRows[0];

      if (req.user.role === "moderator" && targetUser.role !== "user") {
        return res.status(403).json({
          message: "Moderator chỉ được khóa/mở tài khoản user thường",
        });
      }

      const finalStatus = is_active ? 1 : 0;

      await db.query("UPDATE users SET is_active = ? WHERE id = ?", [
        finalStatus,
        userId,
      ]);

      await createSystemLog({
        user_id: req.user.id,
        action: "admin_update_user_status",
        entity_type: "user",
        entity_id: userId,
        description:
          finalStatus === 1
            ? `${req.user.role} ${req.user.email} đã mở khóa tài khoản ${targetUser.email}`
            : `${req.user.role} ${req.user.email} đã khóa tài khoản ${targetUser.email}`,
        ...requestInfo,
      });

      res.json({
        message:
          finalStatus === 1 ? "Đã mở khóa tài khoản" : "Đã khóa tài khoản",
      });
    } catch (err) {
      console.error("Admin update status error:", err);
      res.status(500).json({ message: "Lỗi server khi cập nhật trạng thái" });
    }
  }
);

// Chỉ Admin được xóa tài khoản
// Mặc định không xóa nếu user còn bể cá
// Nếu truyền ?force=1 thì xóa kèm dữ liệu liên quan
router.delete("/users/:id", authMiddleware, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  let transactionStarted = false;

  try {
    const userId = Number(req.params.id);
    const force = req.query.force === "1";
    const requestInfo = getRequestInfo(req);

    if (!userId) {
      return res.status(400).json({
        message: "Thiếu user_id",
      });
    }

    if (userId === req.user.id) {
      return res.status(403).json({
        message: "Không thể xóa chính tài khoản admin đang đăng nhập",
      });
    }

    const [userRows] = await conn.query(
      "SELECT id, email, role FROM users WHERE id = ?",
      [userId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy tài khoản cần xóa",
      });
    }

    const targetUser = userRows[0];

    const [tankRows] = await conn.query(
      "SELECT id FROM tanks WHERE user_id = ?",
      [userId]
    );

    if (tankRows.length > 0 && !force) {
      await createSystemLog({
        user_id: req.user.id,
        action: "admin_delete_user_blocked_has_data",
        entity_type: "user",
        entity_id: userId,
        description: `Admin ${req.user.email} thử xóa tài khoản ${targetUser.email} nhưng tài khoản còn ${tankRows.length} bể cá/dữ liệu liên quan`,
        ...requestInfo,
      });

      return res.status(409).json({
        message:
          "Tài khoản này còn bể cá/dữ liệu liên quan. Nếu chắc chắn muốn xóa tài khoản test, hãy dùng chức năng xóa kèm dữ liệu.",
        need_force_delete: true,
      });
    }

    await conn.beginTransaction();
    transactionStarted = true;

    let deletedTankCount = 0;
    let deletedDeviceCount = 0;

    if (force) {
      const tankIds = tankRows.map((t) => t.id);
      deletedTankCount = tankIds.length;

      if (tankIds.length > 0) {
        const [deviceRows] = await conn.query(
          `SELECT id FROM devices WHERE tank_id IN (${tankIds
            .map(() => "?")
            .join(",")})`,
          tankIds
        );

        const deviceIds = deviceRows.map((d) => d.id);
        deletedDeviceCount = deviceIds.length;

        if (deviceIds.length > 0) {
          await conn.query(
            `DELETE FROM sensor_data WHERE device_id IN (${deviceIds
              .map(() => "?")
              .join(",")})`,
            deviceIds
          );

          await conn.query(
            `DELETE FROM devices WHERE id IN (${deviceIds
              .map(() => "?")
              .join(",")})`,
            deviceIds
          );
        }

        try {
          await conn.query(
            `DELETE FROM alerts WHERE tank_id IN (${tankIds
              .map(() => "?")
              .join(",")})`,
            tankIds
          );
        } catch (e) {}

        try {
          await conn.query(
            `DELETE FROM actuators WHERE tank_id IN (${tankIds
              .map(() => "?")
              .join(",")})`,
            tankIds
          );
        } catch (e) {}

        try {
          await conn.query(
            `DELETE FROM alert_thresholds WHERE tank_id IN (${tankIds
              .map(() => "?")
              .join(",")})`,
            tankIds
          );
        } catch (e) {}

        await conn.query(
          `DELETE FROM tanks WHERE id IN (${tankIds.map(() => "?").join(",")})`,
          tankIds
        );
      }
    }

    await conn.query("DELETE FROM users WHERE id = ?", [userId]);

    await conn.commit();
    transactionStarted = false;

    await createSystemLog({
      user_id: req.user.id,
      action: force ? "admin_force_delete_user" : "admin_delete_user",
      entity_type: "user",
      entity_id: userId,
      description: force
        ? `Admin ${req.user.email} đã xóa tài khoản ${targetUser.email} kèm dữ liệu liên quan: ${deletedTankCount} bể, ${deletedDeviceCount} thiết bị`
        : `Admin ${req.user.email} đã xóa tài khoản ${targetUser.email}`,
      ...requestInfo,
    });

    res.json({
      message: force
        ? "Đã xóa tài khoản và toàn bộ dữ liệu liên quan"
        : "Xóa tài khoản thành công",
    });
  } catch (err) {
    if (transactionStarted) {
      await conn.rollback();
    }

    console.error("Admin delete user error:", err);

    res.status(500).json({
      message: "Lỗi server khi xóa tài khoản",
    });
  } finally {
    conn.release();
  }
});

// Chỉ Admin đổi gói bể basic/premium
router.patch(
  "/tanks/:id/package",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const tankId = Number(req.params.id);
      const { package_type } = req.body;
      const requestInfo = getRequestInfo(req);

      if (!["basic", "premium"].includes(package_type)) {
        return res.status(400).json({ message: "Gói không hợp lệ" });
      }

      const [tankRows] = await db.query(
        `SELECT id, name, package_type
         FROM tanks
         WHERE id = ?`,
        [tankId]
      );

      if (tankRows.length === 0) {
        return res.status(404).json({
          message: "Không tìm thấy bể cá",
        });
      }

      const tank = tankRows[0];
      const oldPackage = tank.package_type;

      await db.query("UPDATE tanks SET package_type = ? WHERE id = ?", [
        package_type,
        tankId,
      ]);

      await createSystemLog({
        user_id: req.user.id,
        action: "admin_update_tank_package",
        entity_type: "tank",
        entity_id: tankId,
        description: `Admin ${req.user.email} đổi gói bể ${tank.name} từ ${oldPackage} sang ${package_type}`,
        ...requestInfo,
      });

      res.json({
        message: "Cập nhật gói bể cá thành công",
      });
    } catch (err) {
      console.error("Admin update tank package error:", err);
      res.status(500).json({ message: "Lỗi server khi cập nhật gói bể cá" });
    }
  }
);

// Chỉ admin được nâng cấp / gia hạn / hạ gói user
router.patch("/users/:id/plan", authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { plan_type, duration_days } = req.body;
    const requestInfo = getRequestInfo(req);

    if (!userId) {
      return res.status(400).json({
        message: "Thiếu user_id",
      });
    }

    if (!["basic", "premium"].includes(plan_type)) {
      return res.status(400).json({
        message: "Gói không hợp lệ",
      });
    }

    const [userRows] = await db.query(
      `SELECT id, email, role, plan_type, plan_expires_at
       FROM users
       WHERE id = ?`,
      [userId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy người dùng",
      });
    }

    const targetUser = userRows[0];

    // Hạ về Basic
    if (plan_type === "basic") {
      await db.query(
        "UPDATE users SET plan_type = 'basic', plan_expires_at = NULL WHERE id = ?",
        [userId]
      );

      await createSystemLog({
        user_id: req.user.id,
        action: "admin_update_user_plan",
        entity_type: "user",
        entity_id: userId,
        description: `Admin ${req.user.email} hạ tài khoản ${targetUser.email} từ ${targetUser.plan_type} về Basic`,
        ...requestInfo,
      });

      return res.json({
        message: "Đã hạ tài khoản về gói Basic",
      });
    }

    // Nâng cấp Premium
    // duration_days = 0 hoặc null nghĩa là Premium không giới hạn thời gian
    let expiresAt = null;

    if (duration_days && Number(duration_days) > 0) {
      const days = Number(duration_days);

      const [timeRows] = await db.query(
        "SELECT DATE_ADD(NOW(), INTERVAL ? DAY) AS expires_at",
        [days]
      );

      expiresAt = timeRows[0].expires_at;
    }

    await db.query(
      "UPDATE users SET plan_type = 'premium', plan_expires_at = ? WHERE id = ?",
      [expiresAt, userId]
    );

    await createSystemLog({
      user_id: req.user.id,
      action: "admin_update_user_plan",
      entity_type: "user",
      entity_id: userId,
      description: expiresAt
        ? `Admin ${req.user.email} nâng/gia hạn Premium ${duration_days} ngày cho tài khoản ${targetUser.email}`
        : `Admin ${req.user.email} nâng Premium không giới hạn cho tài khoản ${targetUser.email}`,
      ...requestInfo,
    });

    res.json({
      message: expiresAt
        ? `Đã nâng cấp Premium ${duration_days} ngày`
        : "Đã nâng cấp Premium không giới hạn thời gian",
      plan_type: "premium",
      plan_expires_at: expiresAt,
    });
  } catch (err) {
    console.error("Admin update user plan error:", err);
    res.status(500).json({
      message: "Lỗi server khi cập nhật gói người dùng",
    });
  }
});

module.exports = router;