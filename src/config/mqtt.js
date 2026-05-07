const mqtt = require('mqtt');

const client = mqtt.connect(process.env.MQTT_BROKER, { // Tạo client kết nối đến broker từ .env
  reconnectPeriod: 5000,
  connectTimeout: 10000
});

client.on('connect', () => { //Lắng nghe event 'connect' – chạy khi kết nối thành công.
  console.log('MQTT Broker kết nối thành công!');
  // Subscribe tất cả topic liên quan đến sensor
  client.subscribe('aquarium/+/+/sensor', (err) => {
    if (!err) console.log('Đã subscribe topic sensor');
  });
});

client.on('error', (err) => {
  console.error('MQTT lỗi:', err.message);
});

module.exports = client;