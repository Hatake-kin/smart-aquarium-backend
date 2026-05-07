/*
Đây là nơi chứa logic xử lý cho các tác vụ đăng ký và đăng nhập (business logic). Controller nhận request từ route, gọi DB, hash password, tạo token JWT, và trả response.
- Không định nghĩa route (không dùng router).
- Chỉ xử lý dữ liệu và logic → dễ test riêng (unit test).
- Gọi trực tiếp DB pool từ config/db.js.
*/



const bcrypt = require('bcryptjs');           // Import bcrypt để hash và so sánh password
const jwt = require('jsonwebtoken');          // Import JWT để tạo token
const db = require('../config/db');           // Import pool kết nối DB

// Đăng ký người dùng
const register = async (req, res) => {        // Hàm async để dùng await
  const { email, password, full_name } = req.body;  // Lấy dữ liệu từ body request

  if (!email || !password) {                  // Kiểm tra input bắt buộc
    return res.status(400).json({ success: false, message: 'Email và password là bắt buộc' });
  }

  try {
    const salt = await bcrypt.genSalt(10);    // Tạo salt (chuỗi random) để hash password an toàn
    const hashedPassword = await bcrypt.hash(password, salt);  // Hash password + salt

    const [result] = await db.query(          // Thực hiện INSERT vào bảng users
      'INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)',
      [email, hashedPassword, full_name || null]
    );

    res.status(201).json({                    // Trả về thành công (201 Created)
      success: true,
      message: 'Đăng ký thành công',
      userId: result.insertId                 // ID user mới tạo
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {       // Xử lý lỗi email trùng (MySQL error code)
      return res.status(409).json({ success: false, message: 'Email đã tồn tại' });
    }
    console.error('Register error:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

// Đăng nhập
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email và password là bắt buộc' });
  }

  try {
    const [[user]] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Email hoặc password không đúng' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);  // So sánh password gốc với hash
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Email hoặc password không đúng' });
    }

    const token = jwt.sign(                   // Tạo JWT token
      { id: user.id, email: user.email, role: user.role },  // Payload (dữ liệu nhúng vào token)
      process.env.JWT_SECRET,                 // Khóa bí mật từ .env
      { expiresIn: '1h' }                     // Token hết hạn sau 1 giờ
    );

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      token,                                  // Trả token về client
      user: {                                 // Trả thông tin user cơ bản (không trả password_hash)
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

module.exports = { register, login };        // Export 2 hàm để route dùng


// Lấy thông tin user hiện tại từ token
const getCurrentUser = async (req, res) => {
  try {
    const userId = req.user.id;

    const [[user]] = await db.query(
      `SELECT id, email, full_name, role, is_active, created_at 
       FROM users 
       WHERE id = ?`,
      [userId]
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy user' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_active: user.is_active,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error('Lỗi getCurrentUser:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

module.exports = { login, register, getCurrentUser };   // ← Thêm getCurrentUser vào export