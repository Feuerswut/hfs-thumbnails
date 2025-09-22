exports.version = 5.1 // CHANGED: Version bump
exports.description = "Show thumbnails for images in place of icons. Generates AVIF (AV1) or JPEG thumbnails with mipmap steps."
exports.apiRequired = 8.65 // ctx.state.fileSource
exports.frontend_js = 'main.js'
exports.repo = "feuerswut/hfs-thumbnails"
exports.depend = [{ "repo": "rejetto/sharp", "version": 1 }]
exports.preview = ["https://github.com/rejetto/thumbnails/assets/1367199/d74a8a24-a6f8-4460-93de-74d9d6bd413f"]
exports.config = {
    quality: {
        type: 'number',
        defaultValue: 20,
        min: 1, max: 100,
        helperText: "100 is best quality but bigger size",
        xs: 6,
    },
    pixels: {
        type: 'number',
        defaultValue: 256,
        min: 10, max: 4096,
        helperText: "Dimensions of longest side (default thumbnail size)",
        unit: 'pixels',
        xs: 6,
    },
    defaultFormat: {
        frontend: true,
        type: 'string',
        defaultValue: 'avif',
        helperText: "Default thumbnail format (avif or jpeg)",
        xs: 6,
    },
    stepMultiplier: {
        frontend: true,
        type: 'number',
        defaultValue: 2,
        min: 1.25,
        max: 2,
        helperText: "Mipmap step multiplier (1.5, 1.75 or 2)",
        xs: 6,
    },
    minSize: {
        frontend: true,
        type: 'number',
        defaultValue: 32,
        min: 8,
        max: 256,
        helperText: "Smallest mipmap size in pixels",
        unit: 'pixels',
        xs: 6,
    },
    initialDelay: {
        type: 'number',
        defaultValue: 60,
        min: -1, // CHANGED: Allow -1 to disable
        max: 300,
        helperText: "Delay for async generation. -1 disables it.", // CHANGED: Updated text
        unit: 'seconds',
        xs: 6,
    },
    intervalDelay: {
        type: 'number',
        defaultValue: 10,
        min: 1,
        max: 60,
        helperText: "Delay between each size generation (seconds)",
        unit: 'seconds',
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
    // CHANGED: Added new options for file system caching
    fileSystemCache: {
        type: 'boolean',
        defaultValue: true,
        label: "Store thumbnails as files",
        helperText: "Save thumbnails in the plugin's storage directory for persistence.",
        xs: 6
    },
    cachePath: {
        type: 'string',
        defaultValue: 'thumbnails',
        helperText: "Subdirectory in plugin storage for thumbnail files.",
        xs: 6,
        depends: { fileSystemCache: true }
    },
    regenerateBefore: { type: 'date_time', helperText: "Older are regenerated", xs: 6 },
    log: { type: 'boolean', defaultValue: false, label: "Include thumbnails in log" },
    showTilesInMenu: { frontend: true, type: 'boolean', defaultValue: true, label: "Show tiles in file menu" },
    lazyLoading: { frontend: true,type: 'boolean', defaultValue: true, xs: 7, helperText: "Less traffic but slower displaying" },
    videos: {
        frontend: true,
        type: 'boolean',
        defaultValue: false,
        label: "Enable experimental videos support",
    },
}
exports.changelog = [
    { "version": 5.1, "message": "Added option to disable async generation and to store thumbnails in the file system for persistence." }, // CHANGED: Added changelog entry
    { "version": 5.0, "message": "Added AVIF/JPEG selectable output, mipmap generation and async generation of other sizes" },
    { "version": 4.8, "message": "Added regenerate before and exif configuration" },
    { "version": 4.7, "message": "Added pixels configuration" },
]

exports.configDialog = {
    maxWidth: 'xs',
}

exports.init = async api => {
    // CHANGED: Added more required modules for file system operations
    const { createReadStream } = api.require('fs');
    const { utimes, access, mkdir, writeFile } = api.require('fs/promises');
    const { buffer } = api.require('node:stream/consumers');
    const path = api.require('path');
    const crypto = api.require('crypto');
    const { loadFileAttr, storeFileAttr } = api.require('./misc');

    api.require('fs').rm(api.storageDir + 'cache',  { recursive: true, force: true }, () => {})

    const header = 'x-thumbnail'
    const K = 'thumbnail_v2'

    // CHANGED: Logic for file system cache initialization
    const useFileCache = api.getConfig('fileSystemCache');
    const cacheDir = path.join(api.storageDir, api.getConfig('cachePath') || 'thumbnails');

    if (useFileCache) {
        try {
            await mkdir(cacheDir, { recursive: true });
        } catch (e) {
            console.error(`thumbnails: failed to create cache directory at ${cacheDir}. File caching will be disabled. Error: ${e.message}`);
        }
    }
    
    // CHANGED: Helper to get a safe and unique file path for a cached thumbnail
    function getCacheFilename(fileSource, vKey) {
        const safeVKey = vKey.replace(/[^a-z0-9|\-x.]/gi, '_');
        const hash = crypto.createHash('sha256').update(fileSource).digest('hex');
        return path.join(cacheDir, `${hash}-${safeVKey}.thumb`);
    }

    return {
        middleware(ctx) {
            if (ctx.query.get !== 'thumb') return
            ctx.state.considerAsGui = true
            ctx.state.download_counter_ignore = true
            return async () => {
                if (!ctx.body) return
                if (!api.getConfig('log'))
                    ctx.state.dontLog = true
                const {fileSource} = ctx.state
                if (!fileSource) return

                const { size, mtimeMs: ts } = ctx.state.fileStats

                if (size < api.getConfig('fullThreshold') * 1024)
                    return

                function parseFormat(q) {
                    if (!q) return null
                    const v = String(q).toLowerCase()
                    if (v === 'jpg' || v === 'jpeg') return 'jpeg'
                    if (v === 'av1' || v === 'avif') return 'avif'
                    return null
                }
                const formatQuery = parseFormat(ctx.query.format || ctx.query.fmt || ctx.query.f)
                const defaultFormat = (api.getConfig('defaultFormat') || 'avif').toLowerCase()
                const outFormat = formatQuery || (defaultFormat === 'jpeg' ? 'jpeg' : 'avif')

                const qS = ctx.query.s ? Number(ctx.query.s) : undefined
                const qW = ctx.query.w ? Number(ctx.query.w) : undefined
                const qH = ctx.query.h ? Number(ctx.query.h) : undefined

                let cached = await loadFileAttr(fileSource, K).catch(failSilently) || { ts: 0, variants: {} }

                const regenerateBefore = api.getConfig('regenerateBefore')
                const isFresh = cached?.ts === ts && (!regenerateBefore || (cached.thumbTs && cached.thumbTs >= regenerateBefore))

                ctx.body.end = 1E8
                const content = await buffer(ctx.body)

                async function getOriginalLongSide(buf) {
                    try {
                        const sharpInst = api.customApiCall('sharp', buf)[0]
                        if (!sharpInst || !sharpInst.metadata) return null
                        const meta = await sharpInst.metadata()
                        if (!meta || !meta.width || !meta.height) return null
                        return { w: meta.width, h: meta.height, long: Math.max(meta.width, meta.height) }
                    } catch (e) {
                        console.debug('thumbnails: metadata error', e && e.message || e)
                        return null
                    }
                }

                const orig = await getOriginalLongSide(content)
                const baseSize = Number(api.getConfig('pixels') || 256)
                const step = Number(api.getConfig('stepMultiplier') || 2)
                const minSize = Number(api.getConfig('minSize') || 32)

                function buildMipSizes(originalLong) {
                    const sizes = new Set()
                    sizes.add(Math.max(1, Math.round(baseSize)))
                    let s = baseSize
                    while (true) {
                        s = Math.round(s / step)
                        if (s < minSize) break
                        sizes.add(s)
                        if (s <= minSize) break
                    }
                    if (originalLong) {
                        let up = baseSize
                        while (true) {
                            up = Math.round(up * step)
                            if (up > originalLong) break
                            sizes.add(up)
                            if (up >= originalLong) break
                        }
                        sizes.add(originalLong)
                    }
                    return Array.from(sizes).sort((a,b)=>a-b)
                }

                const originalLong = orig ? orig.long : null
                const mipSizes = buildMipSizes(originalLong)

                function chooseMipForRequested(requested) {
                    if (!requested || mipSizes.length === 0) return baseSize
                    const found = mipSizes.find(x => x >= requested)
                    return found || mipSizes[mipSizes.length - 1]
                }

                let selectedLongSide
                if (qS) selectedLongSide = chooseMipForRequested(qS)
                else if (qW && qH) {
                    const max = Math.max(qW || 0, qH || 0)
                    selectedLongSide = chooseMipForRequested(max)
                } else if (qW) selectedLongSide = chooseMipForRequested(qW)
                else if (qH) selectedLongSide = chooseMipForRequested(qH)
                else selectedLongSide = baseSize

                function variantKey(fmt, size, w, h) {
                    if (w || h) return `${fmt}|${size}|${w||''}x${h||''}`
                    return `${fmt}|${size}`
                }

                const vKey = variantKey(outFormat, selectedLongSide, qW, qH)

                // CHANGED: Overhauled cache retrieval logic to check file system first.
                // Priority 1: Check File System Cache if enabled and file is fresh.
                if (useFileCache && isFresh) {
                    const cacheFilePath = getCacheFilename(fileSource, vKey);
                    try {
                        await access(cacheFilePath); // Check for existence
                        ctx.set(header, 'cache (file)');
                        ctx.type = outFormat === 'jpeg' ? 'image/jpeg' : 'image/avif';
                        return ctx.body = createReadStream(cacheFilePath);
                    } catch (e) {
                        // Not in file cache, will proceed.
                    }
                }

                // Priority 2: Check Attribute Cache
                if (isFresh && cached.variants && cached.variants[vKey]) {
                    const entry = cached.variants[vKey];
                    ctx.set(header, 'cache (attr)');
                    if (entry.type) ctx.type = entry.type;
                    return ctx.body = Buffer.from(entry.base64, 'base64');
                }

                ctx.set(header, 'generated')

                let resizeW = undefined, resizeH = undefined
                if (qW || qH) {
                    if (orig) {
                        if (orig.w >= orig.h) {
                            resizeW = selectedLongSide
                            if (qH) resizeH = qH
                        } else {
                            resizeH = selectedLongSide
                            if (qW) resizeW = qW
                        }
                    } else {
                        resizeW = selectedLongSide
                        if (qH) resizeH = qH
                    }
                } else {
                    resizeW = selectedLongSide
                }

                async function generateAndStore(fmt, sizeLong, optW, optH, recursionDepth = 0) {
                    try {
                        const maxRecursion = 3;
                        if (recursionDepth > maxRecursion) {
                            console.debug(`thumbnails: reached max recursion depth (${maxRecursion})`);
                            return null;
                        }

                        const inst = api.customApiCall('sharp', content)[0]
                        if (!inst) throw new Error('missing "sharp" plugin')

                        const resizeArgs = []
                        if (typeof optW === 'number' && !isNaN(optW)) resizeArgs.push(Math.round(optW))
                        else resizeArgs.push(undefined)
                        if (typeof optH === 'number' && !isNaN(optH)) resizeArgs.push(Math.round(optH))

                        let pipeline = inst.resize(resizeArgs[0], resizeArgs[1], { fit: 'inside' }).rotate()

                        const quality = Number(api.getConfig('quality') || 80)
                        let outBuf
                        if (fmt === 'jpeg') {
                            pipeline = pipeline.jpeg({ quality })
                            outBuf = Buffer.from(await pipeline.toBuffer())
                        } else {
                            if (typeof pipeline.avif !== 'function') {
                                pipeline = pipeline.jpeg({ quality })
                                outBuf = Buffer.from(await pipeline.toBuffer())
                            } else {
                                pipeline = pipeline.avif({ quality })
                                outBuf = Buffer.from(await pipeline.toBuffer())
                            }
                        }
                        const mime = fmt === 'jpeg' ? 'image/jpeg' : (pipeline.avif ? 'image/avif' : 'image/jpeg')

                        // CHANGED: Store in both file cache and attribute cache
                        const currentVKey = variantKey(fmt, sizeLong, optW, optH);

                        // Store in attribute cache
                        cached.variants = cached.variants || {}
                        cached.variants[currentVKey] = {
                            base64: outBuf.toString('base64'),
                            type: mime,
                            sizeLong,
                            created: Date.now()
                        }
                        
                        // Store in file system cache if enabled
                        if (useFileCache) {
                            const cacheFilePath = getCacheFilename(fileSource, currentVKey);
                            writeFile(cacheFilePath, outBuf).catch(e =>
                                console.debug(`thumbnails: failed to write file cache: ${e.message || e}`)
                            );
                        }

                        storeFileAttr(fileSource, K, Object.assign({ ts, thumbTs: new Date() }, cached)).catch(failSilently)
                        return { buf: outBuf, mime }
                    } catch (e) {
                        console.debug('thumbnails plugin: generate error', e && e.message || e, fileSource)
                        if (sizeLong > 32) {
                            const fallbackSize = Math.max(32, Math.floor(sizeLong * 0.5));
                            console.debug(`thumbnails: reducing size from ${sizeLong}px to ${fallbackSize}px and retrying`);
                            const ratio = fallbackSize / sizeLong;
                            const fallbackW = optW ? Math.round(optW * ratio) : undefined;
                            const fallbackH = optH ? Math.round(optH * ratio) : undefined;
                            return generateAndStore(fmt, fallbackSize, fallbackW, fallbackH, recursionDepth + 1);
                        }
                        return null;
                    }
                }

                const primary = await generateAndStore(outFormat, selectedLongSide, resizeW, resizeH)
                if (!primary) return error(501, 'thumbnail generation failed')
                ctx.type = primary.mime
                ctx.body = primary.buf

                cached.ts = ts
                cached.thumbTs = new Date()
                storeFileAttr(fileSource, K, cached).catch(failSilently)

                // CHANGED: Added check to disable async generation if initialDelay is -1
                const initialDelay = Number(api.getConfig('initialDelay') || 60);
                if (initialDelay === -1) {
                    console.debug("thumbnails: async generation is disabled.");
                } else {
                    const intervalDelay = (api.getConfig('intervalDelay') || 10) * 1000;
                    setTimeout(async () => {
                        try {
                            const finalOrig = await getOriginalLongSide(content) || orig
                            const finalMipSizes = buildMipSizes(finalOrig ? finalOrig.long : originalLong)
                            const tasks = []

                            for (const s of finalMipSizes) {
                                if (s === selectedLongSide) continue
                                
                                const key = variantKey(outFormat, s);
                                // CHANGED: Also check file system cache before queueing async task
                                let isCached = cached.variants && cached.variants[key];
                                if (useFileCache && !isCached) {
                                    try {
                                        await access(getCacheFilename(fileSource, key));
                                        isCached = true;
                                    } catch(e) { /* not in file cache */ }
                                }

                                if (isCached) {
                                    console.debug(`thumbnails: async generation skipping already cached size ${s}px`)
                                    continue
                                }

                                tasks.push(async () => {
                                    const res = await generateAndStore(outFormat, s, s, undefined);
                                    return res;
                                })
                            }

                            console.debug(`thumbnails: async generation scheduled for ${tasks.length} sizes`)
                            for (let i = 0; i < tasks.length; i++) {
                                if (i > 0) {
                                    await new Promise(resolve => setTimeout(resolve, intervalDelay))
                                }
                                try {
                                    const result = await tasks[i]();
                                    if (result) {
                                        await storeFileAttr(fileSource, K, cached).catch(failSilently)
                                    }
                                } catch (e) {
                                    failSilently(e)
                                }
                            }
                            if (tasks.length > 0) {
                                cached.ts = ts
                                cached.thumbTs = new Date()
                                await storeFileAttr(fileSource, K, cached).catch(failSilently)
                                await utimes(fileSource, new Date(ts), new Date(ts)).catch(failSilently)
                            }
                        } catch (e) {
                            failSilently(e)
                        }
                    }, initialDelay * 1000)
                }
            }

            function error(code, body) {
                ctx.status = code
                ctx.type = 'text'
                ctx.body = body
            }
        }
    }

    function failSilently(e) {
        console.debug(`thumbnails: ${e && e.message || e}`)
    }
}
