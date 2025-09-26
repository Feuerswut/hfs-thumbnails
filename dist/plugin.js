exports.version = 1.003
exports.description = "Show thumbnails for images in place of icons. Advanced pseudo-CDN features"
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
        defaultValue: [250],
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
        helperText: "Dimensions of longest side (default thumbnail size mips)",
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
}

exports.changelog = [
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

    // failSilently available before use
    function failSilently(e) {
        console.debug(`thumbnails: ${e && e.message || e}`);
    }

    // Directory for generated files (you wanted to keep api.storageDir directly)
    const cacheDir = api.storageDir;
    await mkdir(cacheDir, { recursive: true });

    // Helper to get a safe and unique file path for a cached thumbnail
    function getCacheFilename(fileSource, vKey) {
        const safeVKey = String(vKey).replace(/[^a-z0-9|\-x.]/gi, '_');
        const hash = crypto.createHash('sha256').update(fileSource).digest('hex');
        return path.join(cacheDir, `${hash}-${safeVKey}.thumb`);
    }

    return {
        middleware(ctx) {
            if (ctx.query.get !== 'thumb') return;

            ctx.state.considerAsGui = true;
            ctx.state.download_counter_ignore = true;

            return async () => {
                if (!ctx.body) return;
                if (!api.getConfig('log')) ctx.state.dontLog = true;
                const { fileSource } = ctx.state;
                if (!fileSource) return;

                const { size, mtimeMs: ts } = ctx.state.fileStats;

                if (size < api.getConfig('fullThreshold') * 1024) return;

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

                const qS = ctx.query.s ? Number(ctx.query.s) : undefined;
                const qW = ctx.query.w ? Number(ctx.query.w) : undefined;
                const qH = ctx.query.h ? Number(ctx.query.h) : undefined;

                let cached = await loadFileAttr(fileSource, K).catch(failSilently) || { ts: 0, variants: {} };

                const regenerateBefore = api.getConfig('regenerateBefore');
                const isFresh = cached?.ts === ts && (!regenerateBefore || (cached.thumbTs && cached.thumbTs >= regenerateBefore));

                // compute sizes from config (hfs validates values)
                const imageSizes = api.getConfig('pixels');
                const parsedSizes = [];

                if (Array.isArray(imageSizes)) {
                    for (const v of imageSizes) {
                        // Accept numbers, numeric strings, or objects with an 'entry' field (HFS-like)
                        let n = undefined;
                        if (typeof v === 'number') n = v;
                        else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
                        else if (v && typeof v === 'object') {
                            if ('entry' in v) n = Number(v.entry);
                            else if ('value' in v) n = Number(v.value);
                        }
                        if (Number.isFinite(n) && n > 0) parsedSizes.push(Math.round(n));
                    }
                }
                
                const sizes = parsedSizes.sort((a, b) => a - b);
                const DEFAULT_BASE_SIZE = 250;
                const baseSize = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : DEFAULT_BASE_SIZE;

                // We can attempt to serve a fresh cached file without buffering the original:
                // compute selectedLongSide without original info (orig undefined) to derive the requested mip.
                let selectedLongSide;
                if (qS) selectedLongSide = getNextLargest(qS, undefined);
                else if (qW && qH) selectedLongSide = getNextLargest(Math.max(qW || 0, qH || 0), undefined);
                else if (qW) selectedLongSide = getNextLargest(qW, undefined);
                else if (qH) selectedLongSide = getNextLargest(qH, undefined);
                else selectedLongSide = baseSize;

                // If sentinel -1 returned and we don't have original info, abort as requested
                if (selectedLongSide === -1) return false;

                function variantKey(fmt, size, w, h) {
                    if (w || h) return `${fmt}|${size}|${w || ''}x${h || ''}`;
                    return `${fmt}|${size}`;
                }

                const vKey = variantKey(outFormat, selectedLongSide, qW, qH);

                // If file is fresh and variant entry exists we can check disk and stream without buffering
                if (isFresh && cached.variants && cached.variants[vKey]) {
                    const cacheFilePath = getCacheFilename(fileSource, vKey);
                    try {
                        await access(cacheFilePath); // Check for existence
                        ctx.set(header, 'cache (file)');
                        if (cached.variants[vKey].type) ctx.type = cached.variants[vKey].type;
                        return ctx.body = createReadStream(cacheFilePath);
                    } catch (e) {
                        // Not in file cache / missing on disk -> proceed to generation
                    }
                }

                // At this point we will need the original buffer (metadata + generation)
                ctx.body.end = 1E9;
                const content = await buffer(ctx.body);

                async function getOriginalLongSide(buf) {
                    try {
                        const sharpInst = api.customApiCall('sharp', buf)[0];
                        if (!sharpInst || !sharpInst.metadata) return null;
                        const meta = await sharpInst.metadata();
                        if (!meta || !meta.width || !meta.height) return null;
                        return { w: meta.width, h: meta.height, long: Math.max(meta.width, meta.height) };
                    } catch (e) {
                        console.debug('thumbnails: metadata error', e && e.message || e);
                        return null;
                    }
                }

                const orig = await getOriginalLongSide(content);

                // Re-evaluate selectedLongSide with original info (required to detect -1 sentinel)
                if (qS) selectedLongSide = getNextLargest(qS, orig ? orig.long : undefined);
                else if (qW && qH) selectedLongSide = getNextLargest(Math.max(qW || 0, qH || 0), orig ? orig.long : undefined);
                else if (qW) selectedLongSide = getNextLargest(qW, orig ? orig.long : undefined);
                else if (qH) selectedLongSide = getNextLargest(qH, orig ? orig.long : undefined);
                else selectedLongSide = baseSize;

                // If selectedLongSide indicates exceeding original, abort request as requested
                if (selectedLongSide === -1) return false;

                // recompute vKey because selectedLongSide may have changed
                const vKeyFinal = variantKey(outFormat, selectedLongSide, qW, qH);

                // If fresh and disk has it (re-check), serve it
                if (isFresh && cached.variants && cached.variants[vKeyFinal]) {
                    const cacheFilePath = getCacheFilename(fileSource, vKeyFinal);
                    try {
                        await access(cacheFilePath);
                        ctx.set(header, 'cache (file)');
                        if (cached.variants[vKeyFinal].type) ctx.type = cached.variants[vKeyFinal].type;
                        return ctx.body = createReadStream(cacheFilePath);
                    } catch (e) {
                        // fall through to generation
                    }
                }

                ctx.set(header, 'generated');

                let resizeW = undefined, resizeH = undefined;
                if (qW || qH) {
                    if (orig) {
                        if (orig.w >= orig.h) {
                            resizeW = selectedLongSide;
                            if (qH) resizeH = qH;
                        } else {
                            resizeH = selectedLongSide;
                            if (qW) resizeW = qW;
                        }
                    } else {
                        resizeW = selectedLongSide;
                        if (qH) resizeH = qH;
                    }
                } else {
                    resizeW = selectedLongSide;
                }

                async function generateAndStore(fmt, sizeLong, optW, optH) {
                    try {
                        const inst = api.customApiCall('sharp', content)[0];
                        if (!inst) throw new Error('missing "sharp" plugin');

                        const resizeArgs = [];
                        if (typeof optW === 'number' && !isNaN(optW)) resizeArgs.push(Math.round(optW));
                        else resizeArgs.push(undefined);
                        if (typeof optH === 'number' && !isNaN(optH)) resizeArgs.push(Math.round(optH));

                        let pipeline = inst.resize(resizeArgs[0], resizeArgs[1], { fit: 'inside' }).rotate();

                        const quality = Number(api.getConfig('quality') || 80);
                        let outBuf;
                        let chosenFmt;

                        if (fmt === 'jpeg') {
                            pipeline = pipeline.jpeg({ quality });
                            chosenFmt = 'jpeg';
                        } else if (fmt === 'webp') {
                            if (typeof pipeline.webp === 'function') {
                                pipeline = pipeline.webp({ quality });
                                chosenFmt = 'webp';
                            }
                        } else if (fmt === 'avif') {
                            if (typeof pipeline.avif === 'function') {
                                pipeline = pipeline.avif({ quality });
                                chosenFmt = 'avif';
                            }
                        }

                        // global fallback to jpeg
                        if (!chosenFmt) {
                            pipeline = pipeline.jpeg({ quality });
                            chosenFmt = 'jpeg';
                        }

                        outBuf = Buffer.from(await pipeline.toBuffer());

                        const mime = chosenFmt === 'jpeg' ? 'image/jpeg'
                                : chosenFmt === 'webp' ? 'image/webp'
                                : 'image/avif';

                        // Use chosenFmt for cache key so stored file reflects actual format
                        const currentVKey = variantKey(chosenFmt, sizeLong, optW, optH);

                        // Store in file system cache and set mtime to original's mtime
                        const cacheFilePath = getCacheFilename(fileSource, currentVKey);
                        writeFile(cacheFilePath, outBuf)
                            .then(() => utimes(cacheFilePath, new Date(ts), new Date(ts)).catch(failSilently))
                            .catch(e => console.debug(`thumbnails: failed to write file cache: ${e.message || e}`));

                        // update attribute cache entry
                        cached.variants = cached.variants || {};
                        cached.variants[currentVKey] = {
                            type: mime,
                            sizeLong,
                            created: Date.now()
                        };

                        // persist originalMime if not present (best-effort)
                        cached.originalMime = cached.originalMime || mime;

                        // persist attributes (best-effort)
                        cached.ts = ts;
                        cached.thumbTs = new Date();
                        storeFileAttr(fileSource, K, cached).catch(failSilently);

                        return { buf: outBuf, mime, currentVKey };
                    } catch (e) {
                        console.debug('thumbnails plugin: generate error', e && e.message || e, fileSource);
                        return null;
                    }
                }

                const primary = await generateAndStore(outFormat, selectedLongSide, resizeW, resizeH);
                if (!primary) return error(501, 'thumbnail generation failed');
                ctx.type = primary.mime;
                ctx.body = primary.buf;

                // ensure persisted attributes/timestamps are up to date (already updated in generateAndStore, but ensure)
                cached.ts = ts;
                cached.thumbTs = cached.thumbTs || new Date();
                await storeFileAttr(fileSource, K, cached).catch(failSilently);

                // done
                return;

                function error(code, body) {
                    ctx.status = code;
                    ctx.type = 'text';
                    ctx.body = body;
                }
            };
        }
    };
};