const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const {
  createSystemLog,
  getRequestInfo,
} = require("../services/log.service");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "demo_secret_key";

// Middleware kiểm tra token
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

// Sinh mã bể cá tự động
function generateTankCode() {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `TANK${random}`;
}

// Kiểm tra role quản lý
function isManager(role) {
  return role === "admin" || role === "moderator";
}

// Lấy gói thật sự đang có hiệu lực của user
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

// ===============================
// LẤY DANH SÁCH BỂ CÁ
// ===============================
router.get("/", authMiddleware, async (req, res) => {
  try {
    let rows;

    // Admin + Moderator xem tất cả bể
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
      // User thường chỉ xem bể của mình
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

      // Nếu hết premium thì chỉ bể đầu tiên còn dùng như Basic, bể còn lại coi như vượt giới hạn
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

    // Admin được chọn package_type khi tạo bể
    if (req.user.role === "admin") {
      const validPackages = ["basic", "premium"];

      finalPackageType = validPackages.includes(package_type)
        ? package_type
        : "basic";
    }

    // User thường: xét gói tài khoản còn hiệu lực hay không
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

    // Moderator mặc định tạo Basic, không tự cấp Premium
    if (req.user.role === "moderator") {
      finalPackageType = "basic";
    }

    let tankCode = generateTankCode();

    // Đề phòng trùng tank_code
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

module.exports = router;