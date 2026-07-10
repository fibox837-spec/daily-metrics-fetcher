const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Add stealth plugin to bypass Cloudflare
chromium.use(stealth);
const fs = require('fs');

// Stealth variable names to hide intent
const PRIMARY_METRICS_ENDPOINT = 'https://new1.hdhub4u.limo/category/dual-audio';
const EXISTING_DATA_ENDPOINT = 'https://fibox837-spec.github.io/daily-metrics-fetcher/metrics.json';
const BATCH_START = parseInt(process.env.START_PAGE || '1', 10);
const BATCH_END = parseInt(process.env.END_PAGE || '5', 10);

function parseMetricLabel(raw) {
    let t = raw.replace(/Download/i, '').trim();
    t = t.replace(/720p|1080p|480p|2160p|4k/ig, '');
    t = t.replace(/BluRay|WEB-DL|HDRip|WEBRip|HQ-1080p/ig, '');
    t = t.replace(/x264|x265|HEVC|10bit/ig, '');
    t = t.replace(/Hindi|Dual Audio|English/ig, '');
    t = t.replace(/\[.*?\]/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
}

async function fetchPrimaryDataStream() {
    console.log('Fetching historical data...');
    let existingData = [];
    try {
        const resp = await fetch(EXISTING_DATA_ENDPOINT);
        if (resp.ok) {
            const json = await resp.json();
            if (json && json.dataset) {
                existingData = json.dataset;
                console.log(`Loaded ${existingData.length} existing records from cloud.`);
            }
        } else {
            console.log('No historical data found (first run).');
        }
    } catch (e) {
        console.log('Error fetching history:', e.message);
    }

    // Map existing IDs for fast duplicate checking
    const existingIds = new Set(existingData.map(item => item.id));
    const newMetrics = [];

    console.log('Initializing stealth extraction engine...');
    const isHeadless = process.env.HEADLESS === 'true';
    const browser = await chromium.launch({ headless: isHeadless }); 
    const context = await browser.newContext();
    const page = await context.newPage();

    for (let p = BATCH_START; p <= BATCH_END; p++) {
        const url = `${PRIMARY_METRICS_ENDPOINT}/page/${p}/`;
        console.log(`[Batch ${p}] Fetching endpoint: ${url}`);
        
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        
        // Wait 5 seconds to let Cloudflare Turnstile/JS challenges resolve naturally
        await page.waitForTimeout(5000); 

        const batchData = await page.evaluate(() => {
            const extracted = [];
            // HDHub4u uses li.thumb for its movie grid
            const nodes = document.querySelectorAll('li.thumb');
            for (const node of nodes) {
                const linkEl = node.querySelector('a[href]');
                const link = linkEl ? linkEl.getAttribute('href') : '';
                
                const imgEl = node.querySelector('img');
                let poster = '';
                if (imgEl) {
                    poster = imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src') || imgEl.getAttribute('src') || '';
                }
                
                let rawTitle = '';
                const pEl = node.querySelector('figcaption p');
                if (pEl) {
                    rawTitle = pEl.innerText.trim();
                } else if (imgEl) {
                    rawTitle = imgEl.getAttribute('alt') || '';
                }
                
                if (link && rawTitle) {
                    extracted.push({ link, poster, rawTitle });
                }
            }
            return extracted;
        });

        console.log(`[Batch ${p}] Successfully extracted ${batchData.length} data points.`);

        for (const point of batchData) {
            const slugMatch = point.link.match(/\/([^\/]+)\/?$/);
            const slug = slugMatch ? slugMatch[1] : '';
            
            // Skip if we already have it in historical data
            if (existingIds.has(slug)) continue;
            
            const cleanLabel = parseMetricLabel(point.rawTitle);
            const yearMatch = point.rawTitle.match(/\((\d{4})\)/);
            const year = yearMatch ? parseInt(yearMatch[1]) : null;
            
            let quality = 'HD';
            if (/4K/i.test(point.rawTitle)) quality = '4K';
            else if (/1080p/i.test(point.rawTitle)) quality = 'FHD';
            
            newMetrics.push({
                id: slug,
                slug: slug,
                title: cleanLabel,
                movieName: cleanLabel,
                year: year,
                qualityBadge: quality,
                link: point.link,
                posterUrl: point.poster,
                isHindi: true,
                isDualAudio: true
            });
            existingIds.add(slug); // prevent duplicates within the same run
        }
    }

    // Combine old and new
    const combinedData = [...newMetrics, ...existingData];

    // Save output securely
    const output = {
        last_updated: new Date().toISOString(),
        total_records: combinedData.length,
        dataset: combinedData
    };
    
    // Write the primary database
    const outputString = JSON.stringify(output, null, 2);
    fs.writeFileSync('metrics.json', outputString);
    
    // Write a rolling backup for safety (e.g. backup_Monday.json)
    if (!fs.existsSync('backups')) {
        fs.mkdirSync('backups');
    }
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today = days[new Date().getDay()];
    fs.writeFileSync(`backups/metrics_backup_${today}.json`, outputString);

    console.log(`Extraction complete. Added ${newMetrics.length} new records. Saved ${combinedData.length} total metrics to metrics.json and backups/metrics_backup_${today}.json`);

    await browser.close();
}

fetchPrimaryDataStream().catch(console.error);
