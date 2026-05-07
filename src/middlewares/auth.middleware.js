/*
Middleware kiểm tra JWT token trong header của request → dùng để bảo vệ route sau này (ví dụ chỉ user đã login mới tạo bể, xem camera premium...).
- Tái sử dụng cho nhiều route (không lặp code verify token).
- Gắn thông tin user vào req.user để controller dùng.
*/





const jwt = require('jsonwebtoken');

const auth = async (req, res, next) => {
  // Lấy token từ header Authorization (dạng "Bearer token")
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, message: 'Không có token, truy cập bị từ chối' });
  }

  try {
    // Verify token với secret key từ .env
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Gắn thông tin user vào req để route sau dùng
    req.user = decoded; // decoded chứa { id, email, role }

    next(); // Cho phép đi tiếp đến controller
  } catch (err) {
    res.status(401).json({ success: false, message: 'Token không hợp lệ' });
  }
};

module.exports = auth;