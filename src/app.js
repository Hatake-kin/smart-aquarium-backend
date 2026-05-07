require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

// Nếu chạy trên Railway/Render/Vercel proxy thì Express cần trust proxy
app.set("trust proxy", 1);

// ====================== ROUTE IMPORTS ======================
const authRoutes = require("./routes/auth.routes");
const tankRoutes = require("./routes/tank.routes");
const actuatorRoutes = require("./routes/actuator.routes");
const deviceRoutes = require("./routes/device.routes");
const sensorRoutes = require("./routes/sensor.routes");
const alertRoutes = require("./routes/alert.routes");
const userRoutes = require("./routes/user.routes");
const locationRoutes = require("./routes/location.routes");
const adminRoutes = require("./routes/admin.routes");
const cameraRoutes = require("./routes/camera.routes");
const thresholdRoutes = require("./routes/threshold.routes");
const systemLogRoutes = require("./routes/system-log.routes");

// ====================== MIDDLEWARE ======================
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://169.254.135.149:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000,
    message: {
      message: "Quá nhiều request, vui lòng thử lại sau",
    },
  })
);

// Log request debug
app.use((req, res, next) => {
  console.log(
    `[${new Date().toLocaleString()}] ${req.method} ${req.url} - IP: ${req.ip}`
  );
  next();
});

// ====================== PUBLIC ROUTES ======================
app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "Smart Aquarium Backend đang chạy!",
    time: new Date().toLocaleString(),
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Smart Aquarium Backend đang chạy ổn định",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// ====================== API ROUTES ======================
app.use("/api/auth", authRoutes);
app.use("/api/tanks", tankRoutes);
app.use("/api/actuators", actuatorRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/sensors", sensorRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/users", userRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/camera", cameraRoutes);
app.use("/api/thresholds", thresholdRoutes);
app.use("/api/system-logs", systemLogRoutes);

// ====================== NOT FOUND ======================
app.use((req, res) => {
  res.status(404).json({
    message: "Không tìm thấy API endpoint",
    path: req.originalUrl,
  });
});

// ====================== GLOBAL ERROR HANDLER ======================
const errorHandler = require("./middlewares/error.middleware");
app.use(errorHandler);

// Chỉ export Express app.
// Không tạo server, không tạo Socket.io, không init MQTT trong app.js.
module.exports = app;