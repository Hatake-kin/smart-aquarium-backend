const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Lấy thông tin user hiện tại
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

// Cập nhật thông tin profile
const updateUserProfile = async (req, res) => {
  const userId = req.user.id;
  const { full_name } = req.body;

  if (!full_name) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập họ tên' });
  }

  try {
    await db.query(
      'UPDATE users SET full_name = ? WHERE id = ?',
      [full_name, userId]
    );

    res.json({ success: true, message: 'Cập nhật thông tin thành công' });
  } catch (err) {
    console.error('Lỗi updateUserProfile:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

// Đổi mật khẩu
const changePassword = async (req, res) => {
  const userId = req.user.id;
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ mật khẩu cũ và mới' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
  }

  try {
    const [[user]] = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);

    const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Mật khẩu cũ không đúng' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, userId]);

    console.log(`User ${userId} đã đổi mật khẩu thành công`);

    res.json({ success: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    console.error('Lỗi changePassword:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi đổi mật khẩu' });
  }
};

module.exports = { 
  getCurrentUser, 
  updateUserProfile, 
  changePassword 
};