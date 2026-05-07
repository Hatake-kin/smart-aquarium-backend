const errorHandler = (err, req, res, next) => {
  console.error('=== GLOBAL ERROR HANDLER ===');
  console.error('Path:', req.path);
  console.error('Method:', req.method);
  console.error('Message:', err.message);
  console.error('Stack:', err.stack);

  const statusCode = err.status || 500;
  let message = err.message || 'Lỗi server nội bộ';

  // Xử lý một số lỗi phổ biến
  if (err.name === 'JsonWebTokenError' || err.name === 'UnauthorizedError') {
    statusCode = 401;
    message = 'Token không hợp lệ hoặc đã hết hạn';
  } else if (err.code === 'ER_DUP_ENTRY') {
    statusCode = 409;
    message = 'Dữ liệu đã tồn tại';
  }

  res.status(statusCode).json({
    success: false,
    message: message,
    ...(process.env.NODE_ENV === 'development' && { 
      error: err.message,
      stack: err.stack 
    })
  });
};

module.exports = errorHandler;