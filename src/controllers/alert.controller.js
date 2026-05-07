const db = require('../config/db');

const getAlertsByTank = async (req, res) => {
  try {
    const tankId = req.params.tankId;
    const limit = parseInt(req.query.limit) || 20;

    console.log(`[GET Alerts] tankId: ${tankId}, limit: ${limit}`);

    const [alerts] = await db.query(
      `SELECT id, message, severity, is_read, created_at 
       FROM alerts 
       WHERE tank_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [tankId, limit]
    );

    res.json({
      success: true,
      count: alerts.length,
      alerts
    });
  } catch (err) {
    console.error('Lỗi getAlertsByTank:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi lấy alerts' });
  }
};

const markAlertAsRead = async (req, res) => {
  const { alertId } = req.params;

  try {
    const [result] = await db.query(
      'UPDATE alerts SET is_read = TRUE WHERE id = ?',
      [alertId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy alert' });
    }

    res.json({ success: true, message: 'Đã đánh dấu đã đọc' });
  } catch (err) {
    console.error('Lỗi markAlertAsRead:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

module.exports = { getAlertsByTank, markAlertAsRead };