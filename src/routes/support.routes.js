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
    return res.status(401).json({
      message: "Token hết hạn hoặc không hợp lệ",
    });
  }
}

function managerOnly(req, res, next) {
  if (req.user.role !== "admin" && req.user.role !== "moderator") {
    return res.status(403).json({
      message: "Bạn không có quyền quản lý hỗ trợ",
    });
  }

  next();
}

async function ensureSupportRequestsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS support_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      request_type VARCHAR(50) NOT NULL DEFAULT 'technical_support',
      subject VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      admin_reply TEXT NULL,
      handled_by INT NULL,
      handled_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_support_user_id (user_id),
      INDEX idx_support_status (status),
      INDEX idx_support_type (request_type),
      INDEX idx_support_created_at (created_at)
    )
  `);
}

function normalizeRequestType(value) {
  const validTypes = [
    "upgrade_plan",
    "device_issue",
    "technical_support",
    "billing",
    "other",
  ];

  if (validTypes.includes(value)) {
    return value;
  }

  return "technical_support";
}

function normalizeStatus(value) {
  const validStatuses = ["pending", "in_progress", "resolved", "rejected"];

  if (validStatuses.includes(value)) {
    return value;
  }

  return "pending";
}

function getSupportStatusLabel(status) {
  const labels = {
    pending: "Chưa xử lý",
    in_progress: "Đang xử lý",
    resolved: "Đã xử lý",
    rejected: "Từ chối",
  };

  return labels[status] || status;
}

function getSupportTypeLabel(type) {
  const labels = {
    upgrade_plan: "Yêu cầu nâng cấp Premium",
    device_issue: "Báo lỗi thiết bị",
    technical_support: "Hỗ trợ kỹ thuật",
    billing: "Thanh toán / gói dịch vụ",
    other: "Khác",
  };

  return labels[type] || type;
}

function getSocketIo(req) {
  try {
    return (
      req.app.get("io") ||
      req.app.locals?.io ||
      global.io ||
      global._io ||
      null
    );
  } catch (err) {
    return null;
  }
}

function emitToUser(req, userId, eventName, payload) {
  const io = getSocketIo(req);

  if (!io || !userId) {
    return;
  }

  const id = String(userId);

  const rooms = [
    id,
    "user_" + id,
    "user:" + id,
    "user-" + id,
    "user_room_" + id,
  ];

  rooms.forEach((room) => {
    io.to(room).emit(eventName, payload);
  });
}

function emitToManagers(req, eventName, payload) {
  const io = getSocketIo(req);

  if (!io) {
    return;
  }

  const rooms = [
    "admin",
    "moderator",
    "manager",
    "managers",
    "role_admin",
    "role_moderator",
    "manager_admin",
    "manager_moderator",
    "admin_room",
    "moderator_room",
  ];

  rooms.forEach((room) => {
    io.to(room).emit(eventName, payload);
  });
}

router.post("/", authMiddleware, async (req, res) => {
  try {
    await ensureSupportRequestsTable();

    const requestInfo = getRequestInfo(req);
    const userId = Number(req.user.id);
    const requestType = normalizeRequestType(req.body.request_type);
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();

    if (!subject) {
      return res.status(400).json({
        message: "Vui lòng nhập tiêu đề yêu cầu",
      });
    }

    if (!message) {
      return res.status(400).json({
        message: "Vui lòng nhập nội dung yêu cầu",
      });
    }

    if (subject.length > 255) {
      return res.status(400).json({
        message: "Tiêu đề quá dài, tối đa 255 ký tự",
      });
    }

    const [result] = await db.query(
      `INSERT INTO support_requests
       (user_id, request_type, subject, message, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [userId, requestType, subject, message]
    );

    try {
      await createSystemLog({
        user_id: userId,
        action: "create_support_request",
        entity_type: "support_request",
        entity_id: result.insertId,
        description: `User ${req.user.email || userId} gửi yêu cầu hỗ trợ: ${subject}`,
        ...requestInfo,
      });
    } catch (logErr) {
      console.warn("Create support request log failed:", logErr.message);
    }

    const createdPayload = {
      id: result.insertId,
      user_id: userId,
      request_type: requestType,
      request_type_label: getSupportTypeLabel(requestType),
      subject,
      status: "pending",
      status_label: getSupportStatusLabel("pending"),
      message: "Có yêu cầu hỗ trợ mới: " + subject,
      timestamp: new Date().toISOString(),
    };

    emitToManagers(req, "support_request_created", createdPayload);

    res.status(201).json({
      message: "Đã gửi yêu cầu hỗ trợ thành công",
      request_id: result.insertId,
    });
  } catch (err) {
    console.error("Create support request error:", err);
    res.status(500).json({
      message: "Lỗi server khi gửi yêu cầu hỗ trợ",
    });
  }
});

router.get("/my", authMiddleware, async (req, res) => {
  try {
    await ensureSupportRequestsTable();

    const userId = Number(req.user.id);

    const [rows] = await db.query(
      `SELECT
        id,
        user_id,
        request_type,
        subject,
        message,
        status,
        admin_reply,
        handled_by,
        handled_at,
        created_at,
        updated_at
       FROM support_requests
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      message: "Lấy danh sách yêu cầu hỗ trợ thành công",
      requests: rows,
    });
  } catch (err) {
    console.error("Get my support requests error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy yêu cầu hỗ trợ",
    });
  }
});

router.get("/admin", authMiddleware, managerOnly, async (req, res) => {
  try {
    await ensureSupportRequestsTable();

    const status = req.query.status ? String(req.query.status) : "";
    const params = [];

    let where = "";

    if (status && status !== "all") {
      where = "WHERE sr.status = ?";
      params.push(normalizeStatus(status));
    }

    const [rows] = await db.query(
      `SELECT
        sr.id,
        sr.user_id,
        sr.request_type,
        sr.subject,
        sr.message,
        sr.status,
        sr.admin_reply,
        sr.handled_by,
        sr.handled_at,
        sr.created_at,
        sr.updated_at,
        u.email,
        u.full_name,
        u.phone,
        u.plan_type,
        handler.email AS handled_by_email,
        handler.full_name AS handled_by_name
       FROM support_requests sr
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN users handler ON handler.id = sr.handled_by
       ${where}
       ORDER BY
        CASE sr.status
          WHEN 'pending' THEN 1
          WHEN 'in_progress' THEN 2
          WHEN 'resolved' THEN 3
          WHEN 'rejected' THEN 4
          ELSE 5
        END,
        sr.created_at DESC`,
      params
    );

    res.json({
      message: "Lấy danh sách yêu cầu hỗ trợ thành công",
      requests: rows,
    });
  } catch (err) {
    console.error("Admin get support requests error:", err);
    res.status(500).json({
      message: "Lỗi server khi lấy danh sách hỗ trợ",
    });
  }
});

router.patch("/admin/:id", authMiddleware, managerOnly, async (req, res) => {
  try {
    await ensureSupportRequestsTable();

    const requestId = Number(req.params.id);
    const status = normalizeStatus(req.body.status);
    const adminReply =
      req.body.admin_reply === undefined || req.body.admin_reply === null
        ? null
        : String(req.body.admin_reply).trim();

    if (!requestId) {
      return res.status(400).json({
        message: "Thiếu support request id",
      });
    }

    const [rows] = await db.query(
      "SELECT id, user_id, subject, status FROM support_requests WHERE id = ?",
      [requestId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy yêu cầu hỗ trợ",
      });
    }

    await db.query(
      `UPDATE support_requests
       SET status = ?,
           admin_reply = ?,
           handled_by = ?,
           handled_at = NOW()
       WHERE id = ?`,
      [status, adminReply, req.user.id, requestId]
    );

    try {
      const requestInfo = getRequestInfo(req);

      await createSystemLog({
        user_id: req.user.id,
        action: "update_support_request",
        entity_type: "support_request",
        entity_id: requestId,
        description: `${req.user.role} ${req.user.email} cập nhật yêu cầu hỗ trợ #${requestId} sang ${status}`,
        ...requestInfo,
      });
    } catch (logErr) {
      console.warn("Update support request log failed:", logErr.message);
    }

    const updatedPayload = {
      id: requestId,
      user_id: rows[0].user_id,
      subject: rows[0].subject,
      status,
      status_label: getSupportStatusLabel(status),
      admin_reply: adminReply,
      message:
        "Admin đã phản hồi yêu cầu hỗ trợ #" +
        requestId +
        ": " +
        getSupportStatusLabel(status),
      timestamp: new Date().toISOString(),
    };

    emitToUser(req, rows[0].user_id, "support_request_updated", updatedPayload);

    res.json({
      message: "Cập nhật yêu cầu hỗ trợ thành công",
    });
  } catch (err) {
    console.error("Admin update support request error:", err);
    res.status(500).json({
      message: "Lỗi server khi cập nhật yêu cầu hỗ trợ",
    });
  }
});

module.exports = router;
