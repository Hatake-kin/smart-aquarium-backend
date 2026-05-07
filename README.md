# Smart Aquarium Backend

Hệ thống backend IoT quản lý bể cá thông minh sử dụng Node.js, Express, MariaDB, MQTT và Socket.io.

## Tính năng chính

- Quản lý người dùng (Auth JWT)
- Quản lý bể cá (Tanks)
- Quản lý thiết bị cảm biến (Devices)
- Quản lý thiết bị chấp hành (Actuators) với điều khiển realtime qua MQTT
- Cảnh báo tự động (Alerts)
- Realtime cập nhật dữ liệu qua Socket.io
- Hỗ trợ gói Basic/Premium
- Location (Tỉnh/Quận/Phường)

## Cài đặt

1. Clone project
2. Copy `.env.example` thành `.env` và chỉnh sửa thông tin
3. Cài dependencies:
   ```bash
   npm install