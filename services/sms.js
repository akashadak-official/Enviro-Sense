async function sendSmsOtp(phone, code) {
  const number = String(phone || '').replace(/\D/g, '').slice(-10);
  if (number.length !== 10) throw new Error('Admin phone number is missing or invalid');

  const key = process.env.FAST2SMS_KEY;
  if (!key || process.env.DEMO_OUTPUT === '1') {                    // DEMO_OUTPUT=1 prints codes in the terminal
    console.log(`\n[DEMO SMS] To: ${number} | Enviro Sense admin reset CODE: ${code}\n`);
    return;
  }

  const url = `https://www.fast2sms.com/dev/bulkV2?route=otp&variables_values=${code}&numbers=${number}`;
  const res = await fetch(url, { headers: { authorization: key } });
  const data = await res.json();
  if (!data.return) throw new Error(data.message || 'SMS sending failed');
}

module.exports = { sendSmsOtp };