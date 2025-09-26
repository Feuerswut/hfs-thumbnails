exports.version = 1.005
exports.description = "Show thumbnails for images in place of icons. Advanced pseudo-CDN features with mipmap support"
exports.apiRequired = 8.65 // ctx.state.fileSource

exports.frontend_js = 'main.js'
exports.repo = "feuerswut/hfs-thumbnails"
exports.depend = [{ "repo": "rejetto/sharp", "version": 1 }]
exports.preview = ["https://github.com/feuerswut/thumbnails/assets/1367199/d74a8a24-a6f8-4460-93de-74d9d6bd413f"]

exports.config = {
    quality: {
        type: 'number',
        defaultValue: 20,
        min: 1, max: 100,
        helperText: "100 is best quality but bigger size",
        xs: 6,
    },
    pixels: {
        type: 'array',
        defaultValue: [150, 250, 400, 600],
        width: {
            sm: 1200
        },
        fields: { 
            entry: {
                type: 'number',
                label: "Dimension (px)",
                placeholder: 250,
                defaultValue: 250
            }
        },
        helperText: "Dimensions of longest side (thumbnail size mipmaps)",
        unit: 'pixels',
        xs: 6,
    },
    format: {
        type: 'string',
        enum: ['jpeg', 'webp', 'avif'],
        defaultValue: 'jpeg',
        helperText: 'Default thumbnail format',
        xs: 6,
    },
    fullThreshold: {
        type: 'number',
        unit: 'KB',
        defaultValue: 100,
        min: 0,
        label: "Serve original file under",
        helperText: "Don't generate a thumbnail",
        xs: 6,
    },
    regenerateBefore: { 
        type: 'date_time', 
        helperText: "Older are deleted and regenerated",
        xs: 6 
    },
    log: { 
        type: 'boolean', 
        defaultValue: false, 
        label: "Include thumbnails in log" 
    },
    showTilesInMenu: { 
        frontend: true, 
        type: 'boolean', 
        defaultValue: true, 
        label: "Show tiles in file menu" 
    },
    lazyLoading: { 
        frontend: true,
        type: 'boolean', 
        defaultValue: true, 
        xs: 7, 
        helperText: "Less traffic but slower displaying" 
    },
    videos: {
        frontend: true,
        type: 'boolean',
        defaultValue: false,
        label: "Enable experimental videos support",
    },
    debug: {
        type: 'boolean',
        defaultValue: true,
        label: "Enable debug logging",
        helperText: "Extensive debug output for troubleshooting",
    }
}

exports.changelog = [
    { "version": 1.005, "message": "Fixed early returns and oriented to original working code" },
    { "version": 1.004, "message": "Fixed mipmap resolution selection and disk storage" },
    { "version": 1.003, "message": "Added mipmap support and disk-based caching" },
    { "version": 1, "message": "Complete overhaul of plugin. Please Uninstall and Reinstall" },
]

exports.configDialog = {
    maxWidth: 'xs',
}

exports.init = async api => {
    const path = api.require('path');
    const fs = api.require('fs');
    const { createReadStream } = fs;
    const { loadFileAttr, storeFileAttr } = api.require('./misc');

    const { utimes, access, mkdir, writeFile } = api.require('fs/promises');
    const { buffer } = api.require('node:stream/consumers');

    const crypto = api.require('crypto');

    const header = 'x-thumbnail';
    const K = 'thumb_db';

    // Debug logging helper
    function debugLog(...args) {
        if (api.getConfig('debug')) {
            console.log('[THUMBNAILS DEBUG]', ...args);
        }
    }

    // failSilently available before use
    function failSilently(e) {
        debugLog(`Error (silently handled): ${e && e.message || e}`);
        console.debug(`thumbnails: ${e && e.message || e}`);
    }

    // Directory for generated files
    const cacheDir = api.storageDir;
    await mkdir(cacheDir, { recursive: true });
    debugLog(`Cache directory: ${cacheDir}`);

    // Helper to get a safe and unique file path for a cached thumbnail
    function getCacheFilename(fileSource, vKey) {
        const safeVKey = String(vKey).replace(/[^a-z0-9|\-x.]/gi, '_');
        const hash = crypto.createHash('sha256').update(fileSource).digest('hex').substring(0, 16);
        const filename = `thumb_${hash}_${safeVKey}.cache`;
        return path.join(cacheDir, filename);
    }

    // Parse and validate resolution sizes from config
    function parseConfigSizes() {
        const imageSizes = api.getConfig('pixels');
        debugLog('Raw config pixels:', imageSizes);
        
        const parsedSizes = [];

        if (Array.isArray(imageSizes)) {
            for (const v of imageSizes) {
                let n = undefined;
                if (typeof v === 'number') {
                    n = v;
                } else if (typeof v === 'string' && v.trim() !== '') {
                    n = Number(v);
                } else if (v && typeof v === 'object') {
                    if ('entry' in v) n = Number(v.entry);
                    else if ('value' in v) n = Number(v.value);
                }
                if (Number.isFinite(n) && n > 0) {
                    parsedSizes.push(Math.round(n));
                }
            }
        }
        
        const sizes = parsedSizes.length > 0 ? parsedSizes.sort((a, b) => a - b) : [150, 250, 400, 600];
        debugLog('Parsed and sorted sizes:', sizes);
        return sizes;
    }

    // Find the next larger size than requested, but don't reject if too large
    function getNextLargestSize(requestedSize, availableSizes) {
        debugLog(`Finding next largest size for requested: ${requestedSize}, available: ${availableSizes}`);
        
        // Find the next size that is >= requested
        for (const size of availableSizes) {
            if (size >= requestedSize) {
                debugLog(`Selected size: ${size}`);
                return size;
            }
        }
        
        // If no size is large enough, return the largest available
        const largest = availableSizes[availableSizes.length - 1];
        debugLog(`No size large enough, using largest: ${largest}`);
        return largest;
    }

    // Get the middle resolution as default
    function getDefaultSize(availableSizes) {
        const middleIndex = Math.floor((availableSizes.length - 1) / 2);
        const defaultSize = availableSizes[middleIndex];
        debugLog(`Default size (middle of ${availableSizes.length} sizes): ${defaultSize}`);
        return defaultSize;
    }

    return {
        middleware(ctx) {
            if (ctx.query.get !== 'thumb') return;

            ctx.state.considerAsGui = true;
            ctx.state.download_counter_ignore = true;

            return async () => {
                debugLog('=== THUMBNAIL REQUEST START ===');
                debugLog('Query params:', Object.fromEntries(ctx.query.entries()));
                
                if (!ctx.body) {
                    debugLog('No body, returning');
                    return;
                }
                
                if (!api.getConfig('log')) ctx.state.dontLog = true;
                const { fileSource } = ctx.state;
                if (!fileSource) {
                    debugLog('No fileSource, returning');
                    return;
                }

                debugLog(`Processing file: ${fileSource}`);

                const { size, mtimeMs: ts } = ctx.state.fileStats;
                debugLog(`File stats - size: ${size}, mtime: ${ts}`);

                // Check if file is under threshold - serve original (like original code)
                if (size < api.getConfig('fullThreshold') * 1024) {
                    debugLog(`File size ${size} under threshold, serving original`);
                    return; // Let original ctx.body be served
                }

                // Parse format request
                function parseFormat(q) {
                    if (!q) return null;
                    const v = String(q).toLowerCase();
                    if (v === 'jpg' || v === 'jpeg') return 'jpeg';
                    if (v === 'webp') return 'webp';
                    if (v === 'avif') return 'avif';
                    return null;
                }

                const formatQuery = parseFormat(ctx.query.format || ctx.query.fmt || ctx.query.f);
                const defaultFormat = String(api.getConfig('format') || 'jpeg').toLowerCase();
                const outFormat = formatQuery || defaultFormat;
                debugLog(`Output format: ${outFormat}`);

                // Parse size requests
                const qS = ctx.query.s ? Number(ctx.query.s) : undefined;
                const qW = ctx.query.w ? Number(ctx.query.w) : undefined;
                const qH = ctx.query.h ? Number(ctx.query.h) : undefined;
                debugLog(`Size requests - s: ${qS}, w: ${qW}, h: ${qH}`);

                // Get available sizes from config
                const availableSizes = parseConfigSizes();

                // Load cache metadata
                let cached = await loadFileAttr(fileSource, K).catch(failSilently) || { ts: 0, variants: {} };
                debugLog('Cached metadata:', cached);

                const regenerateBefore = api.getConfig('regenerateBefore');
                const isFresh = cached?.ts === ts && (!regenerateBefore || (cached.thumbTs && new Date(cached.thumbTs) >= new Date(regenerateBefore)));
                debugLog(`Cache freshness check - isFresh: ${isFresh}, cached.ts: ${cached.ts}, file.ts: ${ts}`);

                // Determine requested size
                let requestedSize;
                if (qS) {
                    requestedSize = qS;
                } else if (qW && qH) {
                    requestedSize = Math.max(qW, qH);
                } else if (qW || qH) {
                    requestedSize = qW || qH;
                } else {
                    requestedSize = getDefaultSize(availableSizes);
                }
                debugLog(`Requested size: ${requestedSize}`);

                // Get selected size - always allow generation, never reject
                let selectedSize = getNextLargestSize(requestedSize, availableSizes);
                debugLog(`Selected size: ${selectedSize}`);

                // Generate variant key
                function variantKey(fmt, size, w, h) {
                    if (w || h) return `${fmt}|${size}|${w || ''}x${h || ''}`;
                    return `${fmt}|${size}`;
                }

                const vKey = variantKey(outFormat, selectedSize, qW, qH);
                debugLog(`Variant key: ${vKey}`);

                // Try to serve from disk cache if fresh
                if (isFresh && cached.variants && cached.variants[vKey]) {
                    const cacheFilePath = getCacheFilename(fileSource, vKey);
                    debugLog(`Checking disk cache: ${cacheFilePath}`);
                    try {
                        await access(cacheFilePath);
                        debugLog('Serving from disk cache');
                        ctx.set(header, 'cache (file)');
                        if (cached.variants[vKey].type) {
                            ctx.type = cached.variants[vKey].type;
                        }
                        return ctx.body = createReadStream(cacheFilePath);
                    } catch (e) {
                        debugLog(`Disk cache miss: ${e.message}`);
                    }
                }

                // Need to generate - read original file
                debugLog('Loading original file buffer for generation');
                ctx.body.end = 1E8; // Like original code: 100MB hard limit
                const content = await buffer(ctx.body);
                debugLog(`Loaded ${content.length} bytes`);

                // Calculate resize dimensions (like original code)
                const w = qW || selectedSize;
                const h = qH || selectedSize;
                debugLog(`Resize dimensions: ${w}x${h}`);

                const quality = api.getConfig('quality');
                debugLog(`Quality: ${quality}`);

                ctx.set(header, 'generated');

                // Generate thumbnail (similar to original code structure)
                const sharpInstance = api.customApiCall('sharp', content)[0];
                if (!sharpInstance) {
                    debugLog('Missing sharp plugin');
                    return error(500, 'missing "sharp" plugin');
                }

                let thumbnailBuffer;
                let actualFormat = outFormat;
                let mimeType;

                try {
                    let pipeline = sharpInstance.resize(w, h, { fit: 'inside' }).rotate();

                    // Apply format
                    if (outFormat === 'jpeg') {
                        pipeline = pipeline.jpeg({ quality });
                        mimeType = 'image/jpeg';
                    } else if (outFormat === 'webp') {
                        if (typeof pipeline.webp === 'function') {
                            pipeline = pipeline.webp({ quality });
                            mimeType = 'image/webp';
                        } else {
                            debugLog('WebP not supported, falling back to JPEG');
                            pipeline = pipeline.jpeg({ quality });
                            actualFormat = 'jpeg';
                            mimeType = 'image/jpeg';
                        }
                    } else if (outFormat === 'avif') {
                        if (typeof pipeline.avif === 'function') {
                            pipeline = pipeline.avif({ quality });
                            mimeType = 'image/avif';
                        } else {
                            debugLog('AVIF not supported, falling back to JPEG');
                            pipeline = pipeline.jpeg({ quality });
                            actualFormat = 'jpeg';
                            mimeType = 'image/jpeg';
                        }
                    } else {
                        // Default fallback
                        pipeline = pipeline.jpeg({ quality });
                        actualFormat = 'jpeg';
                        mimeType = 'image/jpeg';
                    }

                    thumbnailBuffer = Buffer.from(await pipeline.toBuffer());
                    debugLog(`Generated ${thumbnailBuffer.length} bytes, format: ${actualFormat}`);

                } catch (e) {
                    debugLog('Generation error:', e.message || e);
                    return error(501, e.message || String(e));
                }

                // Set response
                ctx.type = mimeType;
                ctx.body = thumbnailBuffer;

                // Save to disk cache and update metadata (async, don't wait - like original code)
                const finalVKey = variantKey(actualFormat, selectedSize, qW, qH);
                const cacheFilePath = getCacheFilename(fileSource, finalVKey);
                
                debugLog(`Saving to disk: ${cacheFilePath}`);
                
                // Update cached metadata
                if (!cached.variants) cached.variants = {};
                cached.variants[finalVKey] = {
                    type: mimeType,
                    sizeLong: selectedSize,
                    created: Date.now()
                };
                cached.ts = ts;
                cached.thumbTs = new Date();

                // Save to disk and update metadata (don't wait, like original)
                storeFileAttr(fileSource, K, cached)
                    .then(() => {
                        debugLog('Updated metadata cache');
                        return writeFile(cacheFilePath, thumbnailBuffer);
                    })
                    .then(() => {
                        debugLog('Saved to disk successfully');
                        return utimes(cacheFilePath, new Date(ts), new Date(ts));
                    })
                    .then(() => debugLog('Updated file timestamps'))
                    .catch(failSilently);
                
                debugLog('=== THUMBNAIL REQUEST END ===');

                function error(code, body) {
                    debugLog(`Error response: ${code} - ${body}`);
                    ctx.status = code;
                    ctx.type = 'text';
                    ctx.body = body;
                }
            };
        }
    };
};