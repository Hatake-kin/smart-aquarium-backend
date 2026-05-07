const db = require('../config/db');

const getProvinces = async (req, res) => {
  try {
    const [provinces] = await db.query('SELECT id, name FROM provinces ORDER BY name');
    res.json({ success: true, provinces });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách tỉnh' });
  }
};

const getDistrictsByProvince = async (req, res) => {
  const { provinceId } = req.params;
  try {
    const [districts] = await db.query(
      'SELECT id, name FROM districts WHERE province_id = ? ORDER BY name',
      [provinceId]
    );
    res.json({ success: true, districts });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách quận/huyện' });
  }
};

const getWardsByDistrict = async (req, res) => {
  const { districtId } = req.params;
  try {
    const [wards] = await db.query(
      'SELECT id, name FROM wards WHERE district_id = ? ORDER BY name',
      [districtId]
    );
    res.json({ success: true, wards });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách phường/xã' });
  }
};

module.exports = { getProvinces, getDistrictsByProvince, getWardsByDistrict };