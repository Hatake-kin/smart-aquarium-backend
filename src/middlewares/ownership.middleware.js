const db = require('../config/db');

const checkTankOwnership = async (req, res, next) => {
  // Lấy tankId một cách an toàn từ nhiều nguồn
  const tankId = req.params.tankId || req.params.id;

  console.log('[Ownership Middleware] Params nhận được:', req.params);
  console.log('[Ownership Middleware] tankId =', tankId);

  if (!tankId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Thiếu tank ID. Vui lòng dùng URL dạng /api/actuators/{tankId}/actuators' 
    });
  }

  try {
    const [[tank]] = await db.query(
      'SELECT user_id FROM tanks WHERE id = ?',
      [tankId]
    );

    if (!tank) {
      return res.status(404).json({ success: false, message: 'Bể không tồn tại' });
    }

    if (tank.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền truy cập bể này' });
    }

    // Gắn tankId vào req để controller dùng sau này
    req.tankId = parseInt(tankId);

    next();
  } catch (err) {
    console.error('[Ownership Middleware] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi kiểm tra quyền sở hữu' });
  }
};

module.exports = checkTankOwnership;