/*
- Tạo connection pool an toàn, hiệu suất cao để kết nối MariaDB.
- Load config từ .env (không hardcode).
- Test kết nối ngay khi load file (chỉ chạy 1 lần).
- Export pool để dùng ở mọi nơi trong dự án.
*/

const mysql = require('mysql2/promise');
/*
 - Import thư viện mysql2 phiên bản promise-based (hỗ trợ async/await).
- mysql2/promise là cách dùng hiện đại của mysql2, giúp viết code sạch hơn (không dùng callback hell).
- mysql2 là driver chính thức để kết nối Node.js với MySQL/MariaDB.
*/
const pool = mysql.createPool({ //Tạo một connection pool (hồ chứa kết nối) thay vì tạo kết nối mới mỗi request. Pool giúp tái sử dụng kết nối cũ → tiết kiệm tài nguyên, hiệu suất cao hơn (đặc biệt khi có nhiều request đồng thời).
  host: process.env.DB_HOST, //Lấy địa chỉ host database từ biến môi trường .env (ví dụ: localhost). process.env.DB_HOST được load từ dotenv ở đầu dự án.
  user: process.env.DB_USER, //Tên user database (thường là root trong XAMPP/local dev). Lấy từ .env để không hardcode (an toàn hơn).
  password: process.env.DB_PASSWORD, //mật khẩu của user database
  database: process.env.DB_NAME, //Tên database cần kết nối (ở đây là smart_aquarium). Phải tạo database này trước trong HeidiSQL/phpMyAdmin.
  port: process.env.DB_PORT || 3306, //Port kết nối MySQL/MariaDB (mặc định 3306). || 3306: Nếu .env không có DB_PORT → dùng 3306.
  waitForConnections: true, //Nếu hết kết nối trong pool → chờ (queue) thay vì báo lỗi ngay.Giúp xử lý khi có nhiều request đồng thời.
  connectionLimit: 10, //Giới hạn tối đa 10 kết nối đồng thời trong pool.
  queueLimit: 0, //Không giới hạn hàng đợi (queue). Nếu có >10 request → tất cả sẽ chờ đến lượt (0 = không giới hạn).
  timezone: '+07:00' // Giờ Việt Nam. Rất quan trọng khi lưu created_at, last_login
});

// Test kết nối khi load file (chỉ chạy 1 lần)
(async () => { //Tạo một IIFE (Immediately Invoked Function Expression) async để chạy test kết nối ngay lập tức.
  try { //Bắt đầu khối try-catch để bắt lỗi kết nối.
    const connection = await pool.getConnection();//Lấy một kết nối từ pool (dùng await vì mysql2/promise).Nếu thành công → trả về object connection.
    console.log('Kết nối MariaDB thành công');
    connection.release();//Trả kết nối về pool (không đóng hẳn, để tái sử dụng). Bắt buộc gọi release() sau khi dùng xong.
  } catch (err) {
    console.error('Lỗi kết nối DB:', err.message);
  }
})();

module.exports = pool;