const nodemailer = require("nodemailer");
require("dotenv").config();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendOtpEmail(toEmail, otp) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error("Thiếu GMAIL_USER hoặc GMAIL_APP_PASSWORD trong file .env");
  }

  await transporter.sendMail({
    from: `"Smart Aquarium" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: "Mã OTP đăng nhập Smart Aquarium",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto;">
        <h2>Smart Aquarium - Xác thực đăng nhập</h2>
        <p>Mã OTP đăng nhập của bạn là:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; padding: 16px; background: #f2f2f2; text-align: center;">
          ${otp}
        </div>
        <p>Mã này có hiệu lực trong <b>5 phút</b>.</p>
        <p>Nếu bạn không thực hiện đăng nhập, vui lòng bỏ qua email này.</p>
      </div>
    `,
  });
}

module.exports = {
  sendOtpEmail,
};