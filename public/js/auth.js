// Must have chosen a mode first
const mode = sessionStorage.getItem('es_mode');
if (!mode) window.location.href = 'index.html';

document.getElementById('modeBadge').textContent =
  (mode === 'local' ? '📍 LOCAL MODE' : '🌍 GLOBAL MODE');

// ----- Elements -----
const tabs = document.querySelectorAll('.tab');
const tabsBar = document.querySelector('.tabs');
const views = {
  login:  document.getElementById('loginForm'),
  signup: document.getElementById('signupForm'),
  verify: document.getElementById('verifyForm'),
  forgot: document.getElementById('forgotForm')
};

let DEMO = false;                                   // set from /api/demo/config

function showView(name) {
  Object.entries(views).forEach(([key, form]) => form.classList.toggle('hidden', key !== name));
  tabsBar.classList.toggle('hidden', name === 'verify' || name === 'forgot');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('demoBox').classList.toggle('hidden', !DEMO || name === 'verify' || name === 'forgot');
}

tabs.forEach(t => t.addEventListener('click', () => showView(t.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach(b =>
  b.addEventListener('click', () => showView(b.dataset.goto)));
document.getElementById('toForgot').addEventListener('click', () => showView('forgot'));

// ----- Show / hide password -----
document.querySelectorAll('.eye').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
    btn.classList.toggle('on', show);
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});

// ----- Helpers -----
function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg ' + type;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.data = data;
    throw err;
  }
  return data;
}

// After a successful login: the title block flies to the corner, then the dashboard opens
async function goAfterLogin() {
  await new Promise(r => setTimeout(r, 600));          // let the person read the welcome line
  try {
    document.getElementById('stage').classList.add('leaving');
    await flyBrandToCorner(document.getElementById('brand'));
  } catch (e) { /* animation is optional */ }
  window.location.href = 'dashboard.html';
}

let pendingEmail = '';

function goVerify(email) {
  pendingEmail = email;
  document.getElementById('verifyHint').textContent =
    'We sent a 6-digit code to ' + email + '. Check your inbox (and spam folder). It expires in 10 minutes.';
  document.getElementById('verifyMsg').textContent = '';
  document.getElementById('verifyCode').value = '';
  showView('verify');
}

// ----- Login -----
views.login.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('loginMsg');
  const btn = views.login.querySelector('.btn-primary');
  btn.disabled = true;
  try {
    const data = await post('/api/auth/login', {
      username: document.getElementById('loginUser').value.trim(),
      password: document.getElementById('loginPass').value,
      mode
    });
    showMsg(msg, 'Welcome, ' + data.user.username + '! (' + data.user.role + ')', 'ok');
    goAfterLogin();
  } catch (err) {
    if (err.data && err.data.needsVerification) goVerify(err.data.email);
    else showMsg(msg, err.message, 'error');
  }
  btn.disabled = false;
});

// ----- Signup -----
views.signup.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('signupMsg');
  const btn = views.signup.querySelector('.btn-primary');

  const p1 = document.getElementById('suPass').value;
  const p2 = document.getElementById('suPass2').value;
  if (p1 !== p2) return showMsg(msg, 'Passwords do not match', 'error');

  btn.disabled = true;
  try {
    const data = await post('/api/auth/signup', {
      username: document.getElementById('suUser').value.trim(),
      email: document.getElementById('suEmail').value.trim(),
      phone: document.getElementById('suPhone').value.trim(),
      password: p1
    });
    if (data.user) {                                // online demo: the account is ready, no email code
      showMsg(msg, 'Account created! Welcome, ' + data.user.username, 'ok');
      goAfterLogin();
      return;
    }
    goVerify(data.email);
  } catch (err) {
    if (err.data && err.data.needsVerification) goVerify(err.data.email);
    else showMsg(msg, err.message, 'error');
  }
  btn.disabled = false;
});

// ----- Verify email -----
views.verify.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('verifyMsg');
  try {
    const data = await post('/api/auth/verify-email', {
      email: pendingEmail,
      code: document.getElementById('verifyCode').value.trim()
    });
    showMsg(msg, 'Email verified! Welcome, ' + data.user.username, 'ok');
    goAfterLogin();
  } catch (err) {
    showMsg(msg, err.message, 'error');
  }
});

document.getElementById('resendBtn').addEventListener('click', async () => {
  const msg = document.getElementById('verifyMsg');
  try {
    await post('/api/auth/resend-email', { email: pendingEmail });
    showMsg(msg, 'A new code has been sent', 'ok');
  } catch (err) {
    showMsg(msg, err.message, 'error');
  }
});

// ----- Forgot password -----
let resetUser = '';

document.getElementById('sendCodeBtn').addEventListener('click', async () => {
  const msg = document.getElementById('forgotMsg');
  const username = document.getElementById('fgUser').value.trim();
  if (!username) return showMsg(msg, 'Enter your username', 'error');

  try {
    const data = await post('/api/auth/forgot', { username });
    resetUser = username;
    document.getElementById('forgotHint').textContent = data.channel === 'phone'
      ? 'A code was sent by SMS to the registered phone number.'
      : 'If this account exists, a code was sent to its registered email.';
    document.getElementById('forgotStage1').classList.add('hidden');
    document.getElementById('forgotStage2').classList.remove('hidden');
    showMsg(msg, '', 'ok');
  } catch (err) {
    showMsg(msg, err.message, 'error');
  }
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  const msg = document.getElementById('forgotMsg');
  try {
    await post('/api/auth/reset', {
      username: resetUser,
      code: document.getElementById('fgCode').value.trim(),
      newPassword: document.getElementById('fgNewPass').value
    });
    showMsg(msg, 'Password changed! You can log in now.', 'ok');
    setTimeout(() => {
      document.getElementById('forgotStage2').classList.add('hidden');
      document.getElementById('forgotStage1').classList.remove('hidden');
      showView('login');
    }, 1800);
  } catch (err) {
    showMsg(msg, err.message, 'error');
  }
});

// ----- Online demo: guest login and simplified sign-up -----
fetch('/api/demo/config').then(r => r.json()).then(cfg => {
  DEMO = !!cfg.demo;
  if (DEMO) {
    document.getElementById('toForgot').classList.add('hidden');       // password reset is off in the demo
    showView('login');
  }
}).catch(() => { /* normal (non-demo) server */ });

document.getElementById('guestBtn').addEventListener('click', async () => {
  const msg = document.getElementById('demoMsg');
  const btn = document.getElementById('guestBtn');
  btn.disabled = true;
  try {
    const data = await post('/api/demo/guest', { mode });
    showMsg(msg, 'Welcome, ' + data.user.username + '!', 'ok');
    goAfterLogin();
  } catch (err) {
    showMsg(msg, err.message, 'error');
    btn.disabled = false;
  }
});
