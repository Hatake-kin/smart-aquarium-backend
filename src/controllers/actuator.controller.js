const db = require('../config/db');
const mqttClient = require('../config/mqtt');

// GET: Lấy danh sách actuators của một bể
const getActuators = async (req, res) => {
  const tankId = req.params.tankId;

  console.log(`[GET Actuators] tankId=${tankId}, userId=${req.user?.id}`);

  if (!tankId) {
    return res.status(400).json({ success: false, message: 'Thiếu tank ID' });
  }

  try {
    const [actuators] = await db.query(
      `SELECT id, type, name, pin, status, last_command_at 
       FROM actuators 
       WHERE tank_id = ?`,
      [tankId]
    );

    res.json({
      success: true,
      count: actuators.length,
      actuators
    });
  } catch (err) {
    console.error('[GET Actuators] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi lấy actuators' });
  }
};

// POST: Gửi lệnh điều khiển
const sendCommand = async (req, res) => {
  const { tankId, actId } = req.params;
  const { command } = req.body;

  console.log(`[POST Command] tankId=${tankId}, actId=${actId}, command=${command}`);

  if (!tankId || !actId) {
    return res.status(400).json({ success: false, message: 'Thiếu tank ID hoặc actuator ID' });
  }

  if (!['on', 'off', 'feed', 'auto'].includes(command)) {
    return res.status(400).json({ success: false, message: 'Lệnh không hợp lệ (on, off, feed, auto)' });
  }

  try {
    const [[actuator]] = await db.query(
      'SELECT type FROM actuators WHERE id = ? AND tank_id = ?',
      [actId, tankId]
    );

    if (!actuator) {
      return res.status(404).json({ success: false, message: 'Actuator không tồn tại hoặc không thuộc bể' });
    }

    const userId = req.user.id;
    const topic = `aquarium/${userId}/${tankId}/actuator/${actuator.type}`;
    const payload = JSON.stringify({ command, timestamp: new Date().toISOString() });

    mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        console.error('MQTT publish error:', err);
        return res.status(500).json({ success: false, message: 'Lỗi gửi lệnh qua MQTT' });
      }

      const newStatus = command === 'feed' ? 'feeding' : command;

      db.query(
        'UPDATE actuators SET status = ?, last_command_at = NOW() WHERE id = ?',
        [newStatus, actId]
      );

      console.log(`✅ Gửi lệnh "${command}" thành công đến topic: ${topic}`);

      res.json({
        success: true,
        message: 'Lệnh đã gửi thành công',
        command,
        newStatus,
        topic
      });
    });
  } catch (err) {
    console.error('[POST Command] Lỗi:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server khi gửi lệnh' });
  }
};

// PUT: Cập nhật thông tin actuator
const updateActuator = async (req, res) => {
  const { tankId, actId } = req.params;
  const { name, pin, status } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE actuators 
       SET name = ?, pin = ?, status = ? 
       WHERE id = ? AND tank_id = ?`,
      [name, pin, status, actId, tankId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Actuator không tồn tại hoặc không thuộc bể' });
    }

    res.json({ success: true, message: 'Cập nhật actuator thành công' });
  } catch (err) {
    console.error('Lỗi updateActuator:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

// DELETE: Xóa actuator
const deleteActuator = async (req, res) => {
  const { tankId, actId } = req.params;

  try {
    const [result] = await db.query(
      'DELETE FROM actuators WHERE id = ? AND tank_id = ?',
      [actId, tankId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Actuator không tồn tại hoặc không thuộc bể' });
    }

    res.json({ success: true, message: 'Xóa actuator thành công' });
  } catch (err) {
    console.error('Lỗi deleteActuator:', err.message);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

module.exports = { 
  getActuators, 
  sendCommand, 
  updateActuator, 
  deleteActuator 
};