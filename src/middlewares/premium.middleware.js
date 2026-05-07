const db = require('../config/db');

const checkPremium = async (req, res, next) => {
  try {
    const tankId = req.params.tankId;
    const userId = req.user.id;

    if (!tankId) {
      return res.status(400).json({ success: false, message: 'Thiếu tankId' });
    }

    const [[tank]] = await db.query(
      'SELECT package_type FROM tanks WHERE id = ? AND user_id = ?',
      [tankId, userId]
    );

    if (!tank) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy bể hoặc không thuộc quyền sở hữu' });
    }

    if (tank.package_type !== 'premium') {
      return res.status(403).json({ 
        success: false, 
        message: 'Tính năng này chỉ dành cho gói Premium. Vui lòng nâng cấp gói.' 
      });
    }

    // Gắn thông tin package vào request để dùng sau
    req.tankPackage = tank.package_type;
    next();
  } catch (err) {
    console.error('Premium middleware error:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

module.exports = checkPremium;