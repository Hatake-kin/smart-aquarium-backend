const db = require("../config/db");

async function createSystemLog({
  user_id = null,
  action,
  entity_type = null,
  entity_id = null,
  description = null,
  ip_address = null,
  user_agent = null,
}) {
  try {
    if (!action) {
      console.warn("createSystemLog skipped: missing action");
      return;
    }

    await db.query(
      `INSERT INTO system_logs
       (user_id, action, entity_type, entity_id, description, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        action,
        entity_type,
        entity_id,
        description,
        ip_address,
        user_agent,
      ]
    );
  } catch (err) {
    // Không được để lỗi ghi log làm hỏng chức năng chính
    console.error("Create system log error:", err.message);
  }
}

function getRequestInfo(req) {
  return {
    ip_address:
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      req.ip ||
      null,
    user_agent: req.headers["user-agent"] || null,
  };
}

module.exports = {
  createSystemLog,
  getRequestInfo,
};
