require("dotenv").config();

const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendOtpEmail(toEmail, otp) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("Thiếu RESEND_API_KEY trong biến môi trường");
  }

  const fromEmail =
    process.env.RESEND_FROM || "Smart Aquarium <onboarding@resend.dev>";

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: [toEmail],
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

  if (error) {
    console.error("Resend email error:", error);
    throw new Error(error.message || "Không gửi được OTP qua Resend");
  }
}

module.exports = {
  sendOtpEmail,
};