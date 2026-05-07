const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const { getCurrentUser, updateUserProfile, changePassword } = require('../controllers/user.controller');

// Lấy thông tin user hiện tại
router.get('/me', auth, getCurrentUser);

// Cập nhật thông tin profile
router.put('/me', auth, updateUserProfile);

// Đổi mật khẩu
router.put('/me/password', auth, changePassword);

module.exports = router;