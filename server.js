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
      timeout: 60000
    });

    // Wait for login form
    await page.waitForSelector('input[name="username"], input[type="text"]', { timeout: 30000 });
    
    console.log('Filling login form...');
    // Fill username
    const usernameInput = await page.$('input[name="username"]') || await page.$('input[type="text"]');
    await usernameInput.click({ clickCount: 3 });
    await usernameInput.type(username, { delay: 50 });

    // Fill password
    const passwordInput = await page.$('input[name="password"]') || await page.$('input[type="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(password, { delay: 50 });

    // Click login button
    const loginButton = await page.$('button[type="submit"]') || await page.$('button:contains("Login")');
    if (loginButton) {
      await loginButton.click();
    }

    // Wait for navigation after login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Logged in successfully');

    // Navigate to the schedule page (not payment page)
    const scheduleUrl = `https://www.usvisascheduling.com/en-US/schedule/?reschedule=true`;
    console.log('Navigating to schedule page:', scheduleUrl);
    await page.goto(scheduleUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait a bit for the page to fully load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Make the API call to get available days (correct endpoint from screenshot)
    const cacheString = Date.now().toString();
    const apiUrl = `https://www.usvisascheduling.com/en-US/api/v1/schedule-group/get-family-consular-schedule-days?appd=${appd}&cacheString=${cacheString}`;
    
    console.log('Fetching slot data from API:', apiUrl);
    const slotsData = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
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
