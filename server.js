const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'change-this-secret';

/* ================= AUTH ================= */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

/* ================= ROUTES ================= */
app.get('/', (_, res) => res.json({ status: 'ok' }));
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

/* ================= MAIN ================= */
app.post('/check-slots', authenticate, async (req, res) => {
  const { username, password, appd } = req.body;
  if (!username || !password || !appd) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: puppeteer.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );

    console.log('[INFO] Opening site...');
    await page.goto('https://www.usvisascheduling.com/en-US/login/', {
      waitUntil: 'domcontentloaded'
    });

    /* ================= CLOUDFLARE WAIT ================= */
    console.log('[INFO] Waiting for login form...');
    await page.waitForFunction(() => {
      const inputs = document.querySelectorAll('input');
      return [...inputs].some(i =>
        /email|user|login/i.test(i.placeholder || '') ||
        /username/i.test(i.name || '')
      );
    });

    /* ================= FIND INPUTS DYNAMICALLY ================= */
    const inputs = await page.$$('input');
    let userInput, passInput;

    for (const input of inputs) {
      const type = await input.evaluate(el => el.type);
      const name = await input.evaluate(el => el.name || '');
      const placeholder = await input.evaluate(el => el.placeholder || '');

      if (!userInput && /text|email/i.test(type)) userInput = input;
      if (!passInput && /password/i.test(type)) passInput = input;
    }

    if (!userInput || !passInput) {
      return res.json({
        success: false,
        error: 'Login form blocked by CAPTCHA / Cloudflare'
      });
    }

    await userInput.type(username, { delay: 50 });
    await passInput.type(password, { delay: 50 });

    /* ================= LOGIN ================= */
    await Promise.all([
      page.keyboard.press('Enter'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' })
    ]);

    console.log('[INFO] Logged in');

    /* ================= API FETCH ================= */
    const apiUrl =
      `https://www.usvisascheduling.com/en-US/api/v1/schedule-group/get-family-consular-schedule-entries` +
      `?appd=${appd}&cacheString=${Date.now()}`;

    const slotsData = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      return res.ok ? res.json() : { error: res.status };
    }, apiUrl);

    return res.json({
      success: true,
      data: slotsData,
      checkedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

/* ================= START ================= */
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});


