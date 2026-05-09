require("dotenv").config();
const db = require("./src/config/db");

(async () => {
  try {
    console.log("===== DEVICES KHÔNG CÓ TANK =====");
    const [orphanDevices] = await db.query(`
      SELECT d.*
      FROM devices d
      LEFT JOIN tanks t ON d.tank_id = t.id
      WHERE t.id IS NULL
    `);
    console.table(orphanDevices);

    console.log("===== ACTUATOR STATES KHÔNG CÓ DEVICE =====");
    const [orphanActuators] = await db.query(`
      SELECT a.*
      FROM actuator_states a
      LEFT JOIN devices d ON a.device_id = d.id
      WHERE d.id IS NULL
    `);
    console.table(orphanActuators);

    console.log("===== SENSOR DATA KHÔNG CÓ DEVICE =====");
    const [orphanSensorData] = await db.query(`
      SELECT COUNT(*) AS count
      FROM sensor_data sd
      LEFT JOIN devices d ON sd.device_id = d.id
      WHERE d.id IS NULL
    `);
    console.table(orphanSensorData);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
