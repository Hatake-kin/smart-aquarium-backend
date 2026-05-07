const db = require('../config/db');

// Lấy tất cả bể của user hiện tại
const getMyTanks = async (req, res) => {
  try {
    const [tanks] = await db.query(
      `SELECT id, tank_code, name, package_type, created_at, updated_at 
       FROM tanks 
       WHERE user_id = ? 
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      count: tanks.length,
      tanks
    });
  } catch (err) {
    console.error('Lỗi getMyTanks:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

// Tạo bể mới
const createTank = async (req, res) => {
  const { tank_code, name, package_type = 'basic' } = req.body;
  const userId = req.user.id;

  try {
    const [result] = await db.query(
      'INSERT INTO tanks (user_id, tank_code, name, package_type) VALUES (?, ?, ?, ?)',
      [userId, tank_code, name, package_type]
    );

    res.status(201).json({
      success: true,
      message: 'Tạo bể thành công',
      tankId: result.insertId
    });
  } catch (err) {
    console.error('Lỗi createTank:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi tạo bể' });
  }
};

// Cập nhật thông tin bể
const updateTank = async (req, res) => {
  const { tankId } = req.params;
  const { tank_code, name, package_type } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE tanks 
       SET tank_code = ?, name = ?, package_type = ? 
       WHERE id = ? AND user_id = ?`,
      [tank_code, name, package_type, tankId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Bể không tồn tại hoặc không thuộc quyền sở hữu' });
    }

    res.json({ success: true, message: 'Cập nhật bể thành công' });
  } catch (err) {
    console.error('Lỗi updateTank:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

// Xóa bể
const deleteTank = async (req, res) => {
  const { tankId } = req.params;

  try {
    const [result] = await db.query(
      'DELETE FROM tanks WHERE id = ? AND user_id = ?',
      [tankId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Bể không tồn tại hoặc không thuộc quyền sở hữu' });
    }

    res.json({ success: true, message: 'Xóa bể thành công' });
  } catch (err) {
    console.error('Lỗi deleteTank:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

module.exports = { getMyTanks, createTank, updateTank, deleteTank };