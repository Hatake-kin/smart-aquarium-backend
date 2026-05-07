const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const nodemailer = require("nodemailer");
require("dotenv").config();

function createTransporter() {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD
    ? process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "")
    : "";

  if (!gmailUser || !gmailAppPassword) {
    throw new Error("Thiếu GMAIL_USER hoặc GMAIL_APP_PASSWORD trong file .env");
  }

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,

    // Ép dùng IPv4 để tránh lỗi IPv6 trên Railway
    family: 4,

    auth: {
      user: gmailUser,
      pass: gmailAppPassword,
    },

    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,

    tls: {
      minVersion: "TLSv1.2",
      servername: "smtp.gmail.com",
    },
  });
}

async function sendOtpEmail(toEmail, otp) {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: `"Smart Aquarium" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: "Mã OTP đăng nhập Smart Aquarium",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto;">
        <h2>Smart Aquarium - Xác thực đăng nhập</h2>
        <p>Mã OTP đăng nhập của bạn là:</p>

        <div style="
          font-size: 32px;
          font-weight: bold;
          letter-spacing: 6px;
          padding: 16px;
          background: #f2f2f2;
          text-align: center;
          border-radius: 8px;
        ">
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