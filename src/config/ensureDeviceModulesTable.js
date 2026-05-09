const db = require("./db");

async function ensureDeviceModulesTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS device_modules (
        id INT AUTO_INCREMENT PRIMARY KEY,

        device_id INT NOT NULL,
        tank_id INT NOT NULL,

        module_code VARCHAR(100) NOT NULL,
        name VARCHAR(150) NOT NULL,

        connection_type ENUM('gpio', 'wireless') NOT NULL DEFAULT 'gpio',
        io_mode ENUM('input', 'output') NOT NULL,

        module_type VARCHAR(80) NOT NULL,

        pin INT NULL,
        pin2 INT NULL,
        pin3 INT NULL,

        unit VARCHAR(30) NULL,

        protocol VARCHAR(50) NULL,
        node_type VARCHAR(80) NULL,
        node_code VARCHAR(100) NULL,

        config_json JSON NULL,

        enabled TINYINT(1) NOT NULL DEFAULT 1,

        last_value VARCHAR(100) NULL,
        last_seen DATETIME NULL,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        UNIQUE KEY unique_device_module_code (device_id, module_code),
        INDEX idx_device_modules_device_id (device_id),
        INDEX idx_device_modules_tank_id (tank_id),
        INDEX idx_device_modules_connection_type (connection_type),
        INDEX idx_device_modules_module_type (module_type),
        INDEX idx_device_modules_node_code (node_code),

        CONSTRAINT fk_device_modules_device
          FOREIGN KEY (device_id) REFERENCES devices(id)
          ON DELETE CASCADE,

        CONSTRAINT fk_device_modules_tank
          FOREIGN KEY (tank_id) REFERENCES tanks(id)
          ON DELETE CASCADE
      );
    `);

    console.log("✅ device_modules table ready");
  } catch (err) {
    console.error("❌ Cannot ensure device_modules table:", err);
  }
}

module.exports = {
  ensureDeviceModulesTable,
};