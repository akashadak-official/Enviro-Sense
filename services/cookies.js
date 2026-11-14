'use strict';
// Cookie settings in one place. On a real website (https) cookies must be marked "secure".
const isSecure = () =>
  process.env.COOKIE_SECURE === '1' || (process.env.COOKIE_SECURE !== '0' && process.env.NODE_ENV === 'production');

const options = maxAge => ({ httpOnly: true, sameSite: 'lax', maxAge, secure: isSecure() });

module.exports = { options, isSecure };
