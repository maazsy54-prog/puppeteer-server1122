const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'change-this-secret';

// Middleware to check API secret
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main visa slot checker endpoint
app.post('/check-slots', authenticate, async (req, res) => {
  const { username, password, appd } = req.body;

  if (!username || !password || !appd) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: username, password, appd' 
    });
  }

  let browser = null;
  
  try {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080'
      ]
    });

    const page = await browser.newPage();
    
    // Set realistic viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('Navigating to login page...');
    await page.goto('https://www.usvisascheduling.com/en-US/login/', {
      waitUntil: 'networkidle2',
      timeout: 90000,
    });

    const landedUrl = page.url();
    const landedTitle = await page.title().catch(() => '');
    console.log('Landed URL:', landedUrl);
    if (landedTitle) console.log('Landed title:', landedTitle);

    // Some regions redirect to a Microsoft B2C login domain or show a waiting room / bot challenge.
    // Be a bit more patient and support common selectors across variants.
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const usernameSelector = 'input#signInName, input[name="username"], input[name="Username"], input[type="email"], input[type="text"]';
    const passwordSelector = 'input#password, input[name="password"], input[name="Password"], input[type="password"]';

    console.log('Waiting for login form...');
    try {
      await page.waitForSelector(usernameSelector, { timeout: 60000 });
    } catch (e) {
      const html = await page.content().catch(() => '');
      const looksLikeBotChallenge =
        html.includes('cf-chl') ||
        html.toLowerCase().includes('cloudflare') ||
        html.toLowerCase().includes('attention required') ||
        html.toLowerCase().includes('verify you are human');

      console.error('Login form not found. URL:', page.url());
      if (landedTitle) console.error('Title:', landedTitle);
      console.error('Bot-challenge detected:', looksLikeBotChallenge);
      console.error('HTML snippet:', html.substring(0, 800));

      throw new Error(
        looksLikeBotChallenge
          ? 'Blocked by anti-bot/verification page. Open the URL in a normal browser from the same region to confirm.'
          : `Login form selectors not found. The login page may have changed (URL: ${page.url()}).`
      );
    }

    console.log('Filling login form...');
    // Fill username/email
    const usernameInput =
      (await page.$('input#signInName')) ||
      (await page.$('input[name="username"]')) ||
      (await page.$('input[name="Username"]')) ||
      (await page.$('input[type="email"]')) ||
      (await page.$('input[type="text"]'));

    if (!usernameInput) throw new Error('Could not find username/email input on login page');
    await usernameInput.click({ clickCount: 3 });
    await usernameInput.type(username, { delay: 60 });

    // Fill password
    const passwordInput =
      (await page.$('input#password')) ||
      (await page.$('input[name="password"]')) ||
      (await page.$('input[name="Password"]')) ||
      (await page.$('input[type="password"]'));

    if (!passwordInput) throw new Error('Could not find password input on login page');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(password, { delay: 60 });

    // Click login/next button (note: CSS :contains() is not supported)
    const loginButton =
      (await page.$('button#next')) ||
      (await page.$('button[type="submit"]')) ||
      (await (async () => {
        const [btn] = await page.$x(
          "//button[contains(., 'Sign') or contains(., 'Login') or contains(., 'Next') or contains(., 'Continue')]"
        );
        return btn || null;
      })());

    if (!loginButton) throw new Error('Could not find login button on login page');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => null),
      loginButton.click(),
    ]);

    console.log('Login submitted');

    // Navigate to the schedule page WITH appd context
    // (the website typically includes appd in the schedule URL; without it the API can return "Application not found")
    const scheduleUrl = `https://www.usvisascheduling.com/en-US/schedule/?appd=${encodeURIComponent(appd)}&reschedule=true`;
    console.log('Navigating to schedule page:', scheduleUrl);
    await page.goto(scheduleUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait a bit for the page to fully load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Call the API endpoint seen in the browser (use GET)
    const cacheString = Date.now().toString();
    const apiUrl = `https://www.usvisascheduling.com/en-US/api/v1/schedule-group/get-family-consular-schedule-days?appd=${encodeURIComponent(appd)}&cacheString=${cacheString}`;

    console.log('Fetching slot data from API:', apiUrl);
    const slotsData = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          },
          credentials: 'include'
        });

        if (!response.ok) {
          const errorText = await response.text();
          return { error: `HTTP ${response.status}`, status: response.status, message: errorText };
        }

        return await response.json();
      } catch (err) {
        return { error: err.message };
      }
    }, apiUrl);

    console.log('API response received:', JSON.stringify(slotsData).substring(0, 500));

    if (slotsData.error) {
      // Check if it's a 404 "Application not found" type error
      const statusCode = slotsData.status || 500;
      return res.status(statusCode).json({
        success: false,
        error: slotsData.error,
        message: slotsData.message || 'Failed to fetch slot data'
      });
    }

    // Parse the slots data
    const slots = parseSlots(slotsData);
    
    return res.json({
      success: true,
      slots,
      totalSlots: slots.length,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    if (browser) {
      await browser.close();
      console.log('Browser closed');
    }
  }
});

// Parse slots from API response
function parseSlots(data) {
  const slots = [];
  
  try {
    console.log('Parsing slots data:', JSON.stringify(data).substring(0, 500));
    
    // Handle the structure from get-family-consular-schedule-days endpoint
    if (data && typeof data === 'object') {
      // Check if it's an array of locations with days
      if (Array.isArray(data)) {
        data.forEach(location => {
          const locationName = location.locationName || location.location || location.name || 'Unknown';
          const consulate = location.consulateName || location.consulate || locationName;
          
          // Handle days array
          if (location.days && Array.isArray(location.days)) {
            location.days.forEach(day => {
              slots.push({
                location: locationName,
                consulate,
                date: day.date || day,
                time: day.time || null,
                available: true
              });
            });
          }
          
          // Handle slots array
          if (location.slots && Array.isArray(location.slots)) {
            location.slots.forEach(slot => {
              slots.push({
                location: locationName,
                consulate,
                date: slot.date || slot.appointmentDate,
                time: slot.time || slot.appointmentTime,
                available: true
              });
            });
          }
          
          // Handle availableDates array
          if (location.availableDates && Array.isArray(location.availableDates)) {
            location.availableDates.forEach(dateInfo => {
              slots.push({
                location: locationName,
                consulate,
                date: typeof dateInfo === 'string' ? dateInfo : dateInfo.date,
                time: dateInfo.time || null,
                available: true
              });
            });
          }

          // Handle direct date properties
          if (location.date) {
            slots.push({
              location: locationName,
              consulate,
              date: location.date,
              time: location.time || null,
              available: true
            });
          }
        });
      }
      
      // Handle object with locations property
      if (data.locations && Array.isArray(data.locations)) {
        return parseSlots(data.locations);
      }
      
      // Handle object with results property  
      if (data.results && Array.isArray(data.results)) {
        return parseSlots(data.results);
      }
    }
  } catch (err) {
    console.error('Error parsing slots:', err);
  }
  
  console.log(`Parsed ${slots.length} slots`);
  return slots;
}

app.listen(PORT, () => {
  console.log(`Visa slot checker server running on port ${PORT}`);
});
