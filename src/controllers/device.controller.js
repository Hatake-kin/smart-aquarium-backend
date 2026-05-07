const db = require('../config/db');

const getDevicesByTank = async (req, res) => {
  try {
    const tankId = req.params.tankId;
    console.log(`[GET Devices] tankId: ${tankId}`);

    const [devices] = await db.query(
      `SELECT id, device_code, name, hardware_version, firmware_version, 
              last_seen, battery_level, rssi 
       FROM devices 
       WHERE tank_id = ?`,
      [tankId]
    );

    res.json({
      success: true,
      count: devices.length,
      devices
    });
  } catch (err) {
    console.error('Lỗi getDevicesByTank:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi lấy devices' });
  }
};

const createDevice = async (req, res) => {
  const { tankId } = req.params;
  const { device_code, name, hardware_version, firmware_version } = req.body;

  try {
    const [result] = await db.query(
      `INSERT INTO devices (tank_id, device_code, name, hardware_version, firmware_version) 
       VALUES (?, ?, ?, ?, ?)`,
      [tankId, device_code, name, hardware_version, firmware_version]
    );

    res.status(201).json({
      success: true,
      message: 'Tạo thiết bị thành công',
      deviceId: result.insertId
    });
  } catch (err) {
    console.error('Lỗi createDevice:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi tạo device' });
  }
};

module.exports = { getDevicesByTank, createDevice };