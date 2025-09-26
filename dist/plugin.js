exports.version = 1.004
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

    const { utimes, access, mkdir, writeFile, unlink } = api.require('fs/promises');
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

    // Find the next larger size than requested, or return -1 if request exceeds original
    function getNextLargestSize(requestedSize, originalLongSide, availableSizes) {
        debugLog(`Finding next largest size for requested: ${requestedSize}, original: ${originalLongSide}, available: ${availableSizes}`);
        
        // If we know the original size and request exceeds it, return sentinel
        if (originalLongSide && requestedSize > originalLongSide) {
            debugLog('Requested size exceeds original, returning -1');
            return -1;
        }

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

                // Check if file is under threshold - serve original
                if (size < api.getConfig('fullThreshold') * 1024) {
                    debugLog(`File size ${size} under threshold, serving original`);
                    return;
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

                // First pass: determine requested size without original dimensions
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
                debugLog(`Requested size (first pass): ${requestedSize}`);

                // Get selected size without original info first
                let selectedSize = getNextLargestSize(requestedSize, undefined, availableSizes);
                debugLog(`Selected size (first pass): ${selectedSize}`);

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

                // Need to read original file for metadata and/or generation
                debugLog('Loading original file buffer');
                ctx.body.end = 1E9; // 1GB hard limit
                const content = await buffer(ctx.body);
                debugLog(`Loaded ${content.length} bytes`);

                // Get original dimensions
                async function getOriginalDimensions(buf) {
                    try {
                        const sharpInst = api.customApiCall('sharp', buf)[0];
                        if (!sharpInst || !sharpInst.metadata) return null;
                        const meta = await sharpInst.metadata();
                        if (!meta || !meta.width || !meta.height) return null;
                        return { w: meta.width, h: meta.height, long: Math.max(meta.width, meta.height) };
                    } catch (e) {
                        debugLog('Metadata error:', e.message || e);
                        return null;
                    }
                }

                const orig = await getOriginalDimensions(content);
                debugLog('Original dimensions:', orig);

                // Second pass: re-evaluate with original dimensions
                selectedSize = getNextLargestSize(requestedSize, orig ? orig.long : undefined, availableSizes);
                if (selectedSize === -1) {
                    debugLog('Request exceeds original size, aborting');
                    return false;
                }
                debugLog(`Selected size (final): ${selectedSize}`);

                // Update variant key with final size
                const finalVKey = variantKey(outFormat, selectedSize, qW, qH);
                debugLog(`Final variant key: ${finalVKey}`);

                // Try disk cache again with final key
                if (isFresh && cached.variants && cached.variants[finalVKey]) {
                    const cacheFilePath = getCacheFilename(fileSource, finalVKey);
                    try {
                        await access(cacheFilePath);
                        debugLog('Serving from disk cache (final key)');
                        ctx.set(header, 'cache (file)');
                        if (cached.variants[finalVKey].type) {
                            ctx.type = cached.variants[finalVKey].type;
                        }
                        return ctx.body = createReadStream(cacheFilePath);
                    } catch (e) {
                        debugLog(`Disk cache miss (final): ${e.message}`);
                    }
                }

                // Generate thumbnail
                debugLog('Generating new thumbnail');
                ctx.set(header, 'generated');

                // Calculate resize dimensions
                let resizeW = undefined, resizeH = undefined;
                if (qW || qH) {
                    if (orig) {
                        // Maintain aspect ratio based on orientation
                        if (orig.w >= orig.h) {
                            // Landscape or square - limit by width
                            resizeW = selectedSize;
                            if (qH) {
                                // Calculate proportional height
                                resizeH = Math.round((selectedSize / orig.w) * orig.h);
                                if (resizeH > qH) resizeH = qH;
                            }
                        } else {
                            // Portrait - limit by height
                            resizeH = selectedSize;
                            if (qW) {
                                // Calculate proportional width
                                resizeW = Math.round((selectedSize / orig.h) * orig.w);
                                if (resizeW > qW) resizeW = qW;
                            }
                        }
                    } else {
                        // No original info, use requested directly
                        resizeW = qW || selectedSize;
                        resizeH = qH;
                    }
                } else {
                    // No specific w/h requested, use selected size as max dimension
                    resizeW = selectedSize;
                    resizeH = selectedSize;
                }

                debugLog(`Resize dimensions: ${resizeW}x${resizeH}`);

                async function generateThumbnail(fmt, sizeLong, optW, optH) {
                    try {
                        debugLog(`Generating: format=${fmt}, size=${sizeLong}, w=${optW}, h=${optH}`);
                        
                        const inst = api.customApiCall('sharp', content)[0];
                        if (!inst) throw new Error('missing "sharp" plugin');

                        // Prepare resize arguments
                        const resizeOptions = { fit: 'inside' };
                        let pipeline = inst.resize(optW || null, optH || null, resizeOptions).rotate();

                        const quality = Number(api.getConfig('quality') || 80);
                        let chosenFmt = fmt;

                        // Apply format-specific processing
                        if (fmt === 'jpeg') {
                            pipeline = pipeline.jpeg({ quality });
                        } else if (fmt === 'webp') {
                            if (typeof pipeline.webp === 'function') {
                                pipeline = pipeline.webp({ quality });
                            } else {
                                debugLog('WebP not supported, falling back to JPEG');
                                pipeline = pipeline.jpeg({ quality });
                                chosenFmt = 'jpeg';
                            }
                        } else if (fmt === 'avif') {
                            if (typeof pipeline.avif === 'function') {
                                pipeline = pipeline.avif({ quality });
                            } else {
                                debugLog('AVIF not supported, falling back to JPEG');
                                pipeline = pipeline.jpeg({ quality });
                                chosenFmt = 'jpeg';
                            }
                        } else {
                            // Default fallback
                            pipeline = pipeline.jpeg({ quality });
                            chosenFmt = 'jpeg';
                        }

                        const outBuf = Buffer.from(await pipeline.toBuffer());
                        debugLog(`Generated ${outBuf.length} bytes`);

                        const mime = chosenFmt === 'jpeg' ? 'image/jpeg'
                                : chosenFmt === 'webp' ? 'image/webp'
                                : 'image/avif';

                        // Store to disk (async, don't wait)
                        const actualVKey = variantKey(chosenFmt, sizeLong, optW, optH);
                        const cacheFilePath = getCacheFilename(fileSource, actualVKey);
                        
                        debugLog(`Saving to disk: ${cacheFilePath}`);
                        writeFile(cacheFilePath, outBuf)
                            .then(() => {
                                debugLog(`Saved to disk successfully`);
                                return utimes(cacheFilePath, new Date(ts), new Date(ts));
                            })
                            .then(() => debugLog(`Updated file timestamps`))
                            .catch(e => debugLog(`Failed to save to disk: ${e.message || e}`));

                        // Update metadata cache
                        if (!cached.variants) cached.variants = {};
                        cached.variants[actualVKey] = {
                            type: mime,
                            sizeLong,
                            created: Date.now()
                        };
                        cached.ts = ts;
                        cached.thumbTs = new Date();

                        // Store metadata (async, don't wait)
                        storeFileAttr(fileSource, K, cached)
                            .then(() => debugLog(`Updated metadata cache`))
                            .catch(failSilently);

                        return { buf: outBuf, mime, vKey: actualVKey };
                    } catch (e) {
                        debugLog('Generation error:', e.message || e);
                        return null;
                    }
                }

                const result = await generateThumbnail(outFormat, selectedSize, resizeW, resizeH);
                if (!result) {
                    debugLog('Thumbnail generation failed');
                    return error(501, 'thumbnail generation failed');
                }

                debugLog(`Generated thumbnail successfully: ${result.buf.length} bytes, mime: ${result.mime}`);
                
                ctx.type = result.mime;
                ctx.body = result.buf;
                
                debugLog('=== THUMBNAIL REQUEST END ===');
                return;

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