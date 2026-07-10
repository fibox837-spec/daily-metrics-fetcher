const fs = require('fs');
const cheerio = require('cheerio');

// Constants
const PRIMARY_METRICS_ENDPOINT = 'https://new1.hdhub4u.limo/category/dual-audio';
const EXISTING_DATA_ENDPOINT = 'https://fibox837-spec.github.io/daily-metrics-fetcher/metrics.json';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';
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

async function fetchWithFlareSolverr(url) {
    try {
        const response = await fetch(FLARESOLVERR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cmd: 'request.get',
                url: url,
                maxTimeout: 60000
            })
        });

        if (!response.ok) {
            console.error(`FlareSolverr error: HTTP ${response.status}`);
            return null;
        }

        const data = await response.json();
        if (data && data.solution && data.solution.response) {
            return data.solution.response; // returns raw HTML string
        } else {
            console.error('FlareSolverr response did not contain solution HTML.');
            return null;
        }
    } catch (e) {
        console.error('FlareSolverr fetch failed:', e.message);
        return null;
    }
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

    console.log('Initializing FlareSolverr extraction engine...');
    
    // Check if FlareSolverr is running (optional quick test)
    try {
        await fetch(FLARESOLVERR_URL);
    } catch (e) {
        console.log(`WARNING: FlareSolverr is not reachable at ${FLARESOLVERR_URL}`);
    }

    for (let p = BATCH_START; p <= BATCH_END; p++) {
        const url = `${PRIMARY_METRICS_ENDPOINT}/page/${p}/`;
        console.log(`[Batch ${p}] Fetching endpoint: ${url} via FlareSolverr`);
        
        const html = await fetchWithFlareSolverr(url);
        if (!html) {
            console.log(`[Batch ${p}] Failed to retrieve HTML. Skipping.`);
            continue;
        }

        const $ = cheerio.load(html);
        const batchData = [];

        // HDHub4u uses li.thumb for its movie grid
        $('li.thumb').each((i, el) => {
            const linkEl = $(el).find('a[href]');
            const link = linkEl.attr('href') || '';
            
            const imgEl = $(el).find('img');
            let poster = '';
            if (imgEl.length > 0) {
                poster = imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || '';
            }
            
            let rawTitle = '';
            const pEl = $(el).find('figcaption p');
            if (pEl.length > 0) {
                rawTitle = pEl.text().trim();
            } else if (imgEl.length > 0) {
                rawTitle = imgEl.attr('alt') || '';
            }
            
            if (link && rawTitle) {
                batchData.push({ link, poster, rawTitle });
            }
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
}

fetchPrimaryDataStream().catch(console.error);
