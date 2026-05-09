// server.js = khởi động Express app + Socket.io realtime + MQTT

require("dotenv").config();

const http = require("http");
const app = require("./src/app");
const { Server } = require("socket.io");
const { initMQTT } = require("./src/services/mqtt.service");
const { ensureDeviceModulesTable } = require("./src/config/ensureDeviceModulesTable");

const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://169.254.135.149:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

// Tạo HTTP server từ Express app
const httpServer = http.createServer(app);

// Tạo Socket.io server.
// Dùng path /realtime để tránh đụng cấu hình mặc định /socket.io.
const io = new Server(httpServer, {
  path: "/realtime",
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  },

  // Giữ polling để dễ chạy qua Vercel/Railway proxy hơn.
  transports: ["polling"],
});

// Cho route khác có thể lấy io bằng req.app.get("io") nếu cần
app.set("io", io);

// Socket.io realtime rooms
io.on("connection", (socket) => {
  console.log("Client socket connected:", socket.id);

  socket.on("join_user_room", (userId) => {
    if (!userId) return;

    socket.join(`user_${userId}`);
    console.log(`Socket ${socket.id} joined room user_${userId}`);
  });

  socket.on("join_user", (userId) => {
    if (!userId) return;

    socket.join(`user_${userId}`);
    console.log(`Socket ${socket.id} joined room user_${userId}`);
  });

  socket.on("join_manager_room", (role) => {
    if (role !== "admin" && role !== "moderator") return;

    socket.join("managers");
    console.log(`Socket ${socket.id} joined room managers as ${role}`);
  });

  socket.on("disconnect", () => {
    console.log("Client socket disconnected:", socket.id);
  });
});

async function startServer() {
  await ensureDeviceModulesTable();

  // MQTT chỉ init ở đây, không init trong app.js
  initMQTT(io);

  // Start server
  httpServer.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
    console.log("Socket.io realtime đã sẵn sàng tại path /realtime");
    console.log("Allowed origins:", allowedOrigins);
  });
}

startServer();