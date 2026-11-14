const nodemailer = require('nodemailer');

const configured = process.env.SMTP_USER && process.env.SMTP_PASS && process.env.DEMO_OUTPUT !== '1';   // DEMO_OUTPUT=1 prints codes in the terminal
const transporter = configured
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

async function sendEmailOtp(to, code, purpose) {
  const subject = purpose === 'reset'
    ? 'Enviro Sense: password reset code'
    : 'Enviro Sense: email verification code';

  if (!transporter) {
    console.log(`\n[DEMO EMAIL] To: ${to} | ${subject} | CODE: ${code}\n`);
    return;
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text: `Your Enviro Sense code is ${code}. It expires in 10 minutes.`,
    html: `<div style="font-family:Arial,sans-serif">
             <h2 style="color:#2fb87c">Enviro Sense</h2>
             <p>Your code is:</p>
             <p style="font-size:30px;letter-spacing:6px;font-weight:bold">${code}</p>
             <p>It expires in 10 minutes. If you did not request this, ignore this email.</p>
           </div>`
  });
}

module.exports = { sendEmailOtp };