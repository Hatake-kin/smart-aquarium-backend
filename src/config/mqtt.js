const mqtt = require("mqtt");

const brokerUrl = process.env.MQTT_BROKER || "mqtt://broker.emqx.io";

const client = mqtt.connect(brokerUrl, {
  reconnectPeriod: 5000,
  connectTimeout: 10000,
});

client.on("connect", () => {
  console.log("MQTT Broker kết nối thành công!");

  client.subscribe("aquarium/+/+/sensor", { qos: 1 }, (err) => {
    if (err) {
      console.error("Subscribe topic sensor lỗi:", err.message);
      return;
    }

    console.log("Đã subscribe topic sensor");
  });

  client.subscribe("aquarium/+/+/config_ack", { qos: 1 }, (err) => {
    if (err) {
      console.error("Subscribe topic config_ack lỗi:", err.message);
      return;
    }

    console.log("Đã subscribe topic config_ack");
  });
});

client.on("reconnect", () => {
  console.log("MQTT đang reconnect...");
});

client.on("error", (err) => {
  console.error("MQTT lỗi:", err.message);
});

module.exports = client;