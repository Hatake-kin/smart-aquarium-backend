const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { sendOtpEmail } = require("../services/mail.service");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "demo_secret_key";

// Tạo OTP 8 ký tự gồm chữ hoa + số
function generateOtp(length = 8) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let otp = "";

  for (let i = 0; i < length; i++) {
    otp += chars[Math.floor(Math.random() * chars.length)];
  }

  return otp;
}

// ===============================
// ĐĂNG KÝ TÀI KHOẢN
// ===============================
router.post("/register", async (req, res) => {
  try {
    const { email, password, full_name, phone } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Thiếu email hoặc mật khẩu",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Mật khẩu phải từ 6 ký tự trở lên",
      });
    }

    const [exists] = await db.query("SELECT id FROM users WHERE email = ?", [
      email,
    ]);

    if (exists.length > 0) {
      return res.status(409).json({
        message: "Email đã tồn tại",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await db.query(
      `INSERT INTO users 
       (email, password_hash, full_name, phone, role, is_active) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [email, passwordHash, full_name || null, phone || null, "user", 1]
    );

    return res.json({
      message: "Tạo tài khoản thành công",
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({
      message: "Lỗi server khi tạo tài khoản",
    });
  }
});

// ===============================
// ĐĂNG NHẬP BƯỚC 1
// ===============================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Thiếu email hoặc mật khẩu",
      });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (rows.length === 0) {
      return res.status(401).json({
        message: "Sai email hoặc mật khẩu",
      });
    }

    const user = rows[0];

    if (user.is_active !== 1) {
      return res.status(403).json({
        message: "Tài khoản đã bị khóa",
      });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({
        message: "Sai email hoặc mật khẩu",
      });
    }

    const otp = generateOtp(8);
    const expires = new Date(Date.now() + 5 * 60 * 1000);

    await db.query(
      "UPDATE users SET twofa_code = ?, twofa_expires = ? WHERE id = ?",
      [otp, expires, user.id]
    );

    await sendOtpEmail(user.email, otp);

    console.log(`Đã gửi OTP đăng nhập tới email: ${user.email}`);

    return res.json({
      message:
        "Đăng nhập bước 1 thành công. Mã OTP đã được gửi về Gmail đăng ký.",
      need_2fa: true,
      user_id: user.id,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({
      message: "Lỗi server khi đăng nhập hoặc gửi OTP",
    });
  }
});

// ===============================
// ĐĂNG NHẬP BƯỚC 2
// ===============================
router.post("/verify-otp", async (req, res) => {
  try {
    console.log("Verify OTP body:", req.body);

    const { user_id, otp } = req.body;

    if (!user_id || !otp) {
      return res.status(400).json({
        message: "Thiếu user_id hoặc OTP",
      });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [
      user_id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy tài khoản",
      });
    }

    const user = rows[0];

    if (user.is_active !== 1) {
      return res.status(403).json({
        message: "Tài khoản đã bị khóa",
      });
    }

    const inputOtp = String(otp).trim().toUpperCase();
    const dbOtp = String(user.twofa_code || "").trim().toUpperCase();

    if (!dbOtp || dbOtp !== inputOtp) {
      return res.status(401).json({
        message: "OTP không đúng",
      });
    }

    if (!user.twofa_expires) {
      return res.status(401).json({
        message: "OTP đã hết hạn",
      });
    }

    const now = new Date();
    const expires = new Date(user.twofa_expires);

    if (now > expires) {
      return res.status(401).json({
        message: "OTP đã hết hạn",
      });
    }

    await db.query(
      `UPDATE users 
       SET twofa_code = NULL, 
           twofa_expires = NULL, 
           last_login = NOW() 
       WHERE id = ?`,
      [user.id]
    );

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || "1d",
      }
    );

    console.log(`Đăng nhập OTP thành công: ${user.email}`);

    return res.json({
      message: "Đăng nhập thành công",
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Verify OTP error:", err);
    return res.status(500).json({
      message: "Lỗi server khi xác thực OTP",
      error: err.message,
    });
  }
});

// ===============================
// QUÊN MẬT KHẨU - BƯỚC 1
// Gửi OTP reset password về Gmail
// ===============================
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        message: "Thiếu email",
      });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy tài khoản với email này",
      });
    }

    const user = rows[0];

    if (user.is_active !== 1) {
      return res.status(403).json({
        message: "Tài khoản đã bị khóa, không thể đặt lại mật khẩu",
      });
    }

    const otp = generateOtp(8);
    const expires = new Date(Date.now() + 5 * 60 * 1000);

    await db.query(
      `UPDATE users
       SET password_reset_code = ?,
           password_reset_expires = ?
       WHERE id = ?`,
      [otp, expires, user.id]
    );

    // Tạm dùng lại mail OTP đang có.
    // Nội dung email có thể ghi là OTP đăng nhập, nhưng vẫn dùng được cho reset password.
    await sendOtpEmail(user.email, otp);

    console.log(`Đã gửi OTP đặt lại mật khẩu tới email: ${user.email}`);

    return res.json({
      message:
        "Mã OTP đặt lại mật khẩu đã được gửi về Gmail. Vui lòng kiểm tra hộp thư hoặc mục spam.",
      email: user.email,
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({
      message: "Lỗi server khi gửi OTP đặt lại mật khẩu",
      error: err.message,
    });
  }
});

// ===============================
// QUÊN MẬT KHẨU - BƯỚC 2
// Xác thực OTP và đổi mật khẩu mới
// ===============================
router.post("/reset-password", async (req, res) => {
  try {
    const { email, otp, new_password } = req.body;

    if (!email || !otp || !new_password) {
      return res.status(400).json({
        message: "Thiếu email, OTP hoặc mật khẩu mới",
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        message: "Mật khẩu mới phải từ 6 ký tự trở lên",
      });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy tài khoản",
      });
    }

    const user = rows[0];

    if (user.is_active !== 1) {
      return res.status(403).json({
        message: "Tài khoản đã bị khóa",
      });
    }

    const inputOtp = String(otp).trim().toUpperCase();
    const dbOtp = String(user.password_reset_code || "").trim().toUpperCase();

    if (!dbOtp || dbOtp !== inputOtp) {
      return res.status(401).json({
        message: "OTP đặt lại mật khẩu không đúng",
      });
    }

    if (!user.password_reset_expires) {
      return res.status(401).json({
        message: "OTP đặt lại mật khẩu đã hết hạn",
      });
    }

    const now = new Date();
    const expires = new Date(user.password_reset_expires);

    if (now > expires) {
      return res.status(401).json({
        message: "OTP đặt lại mật khẩu đã hết hạn",
      });
    }

    const newPasswordHash = await bcrypt.hash(new_password, 10);

    await db.query(
      `UPDATE users
       SET password_hash = ?,
           password_reset_code = NULL,
           password_reset_expires = NULL,
           twofa_code = NULL,
           twofa_expires = NULL
       WHERE id = ?`,
      [newPasswordHash, user.id]
    );

    console.log(`Đặt lại mật khẩu thành công: ${user.email}`);

    return res.json({
      message: "Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.",
    });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({
      message: "Lỗi server khi đặt lại mật khẩu",
      error: err.message,
    });
  }
});

module.exports = router;