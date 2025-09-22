exports.version = 5.0
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
        min: 5,
        max: 300,
        helperText: "Initial delay before background generation starts (seconds)",
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
    { "version": 5.0, "message": "Added AVIF/JPEG selectable output, mipmap generation and async generation of other sizes" },
    { "version": 4.8, "message": "Added `regenerate before` and `exif` configuration" },
    { "version": 4.7, "message": "Added `pixels` configuration" },
]

exports.configDialog = {
    maxWidth: 'xs',
}

exports.init = async api => {
    const { createReadStream } = api.require('fs')
    const { utimes } = api.require('fs/promises')
    const { buffer } = api.require('node:stream/consumers')
    const { loadFileAttr, storeFileAttr } = api.require('./misc')

    // Cleanup legacy cache flag (unchanged)
    api.require('fs').rm(api.storageDir + 'cache',  { recursive: true, force: true }, () => {})

    const header = 'x-thumbnail'
    const K = 'thumbnail_v2'

    return {
        middleware(ctx) {
            if (ctx.query.get !== 'thumb') return
            ctx.state.considerAsGui = true
            ctx.state.download_counter_ignore = true
            return async () => {
                if (!ctx.body) return // !body includes 304 responses
                if (!api.getConfig('log'))
                    ctx.state.dontLog = true
                const {fileSource} = ctx.state
                if (!fileSource) return // file not accessible, for some reason, like permissions

                const { size, mtimeMs: ts } = ctx.state.fileStats

                // Do not generate thumbnails for very small files (serves full)
                if (size < api.getConfig('fullThreshold') * 1024)
                    return

                // Helper: parse requested format
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

                // parse requested sizing params
                const qS = ctx.query.s ? Number(ctx.query.s) : undefined
                const qW = ctx.query.w ? Number(ctx.query.w) : undefined
                const qH = ctx.query.h ? Number(ctx.query.h) : undefined

                // load cache object for this file
                let cached = await loadFileAttr(fileSource, K).catch(failSilently) || { ts: 0, variants: {} }

                // if cached.ts matches file ts and regenerateBefore not passed, reuse variants map
                const regenerateBefore = api.getConfig('regenerateBefore')
                const isFresh = cached?.ts === ts && (!regenerateBefore || (cached.thumbTs && cached.thumbTs >= regenerateBefore))
                // We'll still check individual variants below.

                // read full content (we need it to feed sharp and to inspect metadata)
                ctx.body.end = 1E8 // 100MB hard limit for file stream
                const content = await buffer(ctx.body)

                // helper: create sizes (mipmap) from original long side
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
                // If we cannot get original dimensions, fall back to simple behavior: use requested or default pixels only.
                const baseSize = Number(api.getConfig('pixels') || 256)
                const step = Number(api.getConfig('stepMultiplier') || 2)
                const minSize = Number(api.getConfig('minSize') || 32)

                function buildMipSizes(originalLong) {
                    // returns ascending unique integer sizes
                    const sizes = new Set()
                    // include base
                    sizes.add(Math.max(1, Math.round(baseSize)))
                    // downwards
                    let s = baseSize
                    while (true) {
                        s = Math.round(s / step)
                        if (s < minSize) break
                        sizes.add(s)
                        if (s <= minSize) break
                    }
                    // upwards until originalLong (if available)
                    if (originalLong) {
                        let up = baseSize
                        while (true) {
                            up = Math.round(up * step)
                            if (up > originalLong) break
                            sizes.add(up)
                            if (up >= originalLong) break
                        }
                        // ensure original long side is included (but not exceed it)
                        sizes.add(originalLong)
                    }
                    const arr = Array.from(sizes).sort((a,b)=>a-b)
                    return arr
                }

                const originalLong = orig ? orig.long : null
                const mipSizes = buildMipSizes(originalLong)

                // helper: choose target mip size for a requested value (s or w or h)
                function chooseMipForRequested(requested) {
                    if (!requested || mipSizes.length === 0) return baseSize
                    // choose smallest mip >= requested, or largest
                    const found = mipSizes.find(x => x >= requested)
                    return found || mipSizes[mipSizes.length - 1]
                }

                // determine selected size to serve
                let selectedLongSide
                if (qS) selectedLongSide = chooseMipForRequested(qS)
                else if (qW && qH) {
                    // use larger of w/h to compute mip selection
                    const max = Math.max(qW || 0, qH || 0)
                    selectedLongSide = chooseMipForRequested(max)
                } else if (qW) selectedLongSide = chooseMipForRequested(qW)
                else if (qH) selectedLongSide = chooseMipForRequested(qH)
                else selectedLongSide = baseSize

                // Prepare a normalized key for variants
                function variantKey(fmt, size, w, h) {
                    // size is long-side in px used to choose mipmap (number)
                    // w/h are requested width/height if specified (to preserve aspect)
                    // we store by fmt + size + optionally 'w'+'h' to differentiate
                    if (w || h) return `${fmt}|${size}|${w||''}x${h||''}`
                    return `${fmt}|${size}`
                }

                const vKey = variantKey(outFormat, selectedLongSide, qW, qH)

                // if variant cached and fresh, serve it
                if (isFresh && cached.variants && cached.variants[vKey]) {
                    const entry = cached.variants[vKey]
                    ctx.set(header, 'cache')
                    if (entry.type) ctx.type = entry.type
                    return ctx.body = Buffer.from(entry.base64, 'base64')
                }

                // Otherwise we generate selected variant now
                ctx.set(header, 'generated')

                // compute resize parameters for Sharp
                // If qW/qH were provided we pass them (but ensure the long side equals selectedLongSide by fitting inside)
                // If none provided, pass width = selectedLongSide so fit: 'inside' will scale preserving aspect.
                let resizeW = undefined, resizeH = undefined
                if (qW || qH) {
                    // try to honour requested W/H but ensure that the long side used for selection is applied
                    // We'll set either width or height to selectedLongSide depending on original orientation if available.
                    if (orig) {
                        if (orig.w >= orig.h) {
                            // width is long side
                            resizeW = selectedLongSide
                            if (qH) resizeH = qH
                        } else {
                            resizeH = selectedLongSide
                            if (qW) resizeW = qW
                        }
                    } else {
                        // fallback: use selectedLongSide as width
                        resizeW = selectedLongSide
                        if (qH) resizeH = qH
                    }
                } else {
                    // only selectedLongSide known => pass it as width to fit inside (works symmetrically)
                    resizeW = selectedLongSide
                }

                async function generateAndStore(fmt, sizeLong, optW, optH, recursionDepth = 0) {
                    try {
                        // Maximum recursion to prevent infinite loops
                        const maxRecursion = 3;
                        if (recursionDepth > maxRecursion) {
                            console.debug(`thumbnails: reached max recursion depth (${maxRecursion})`);
                            return null;
                        }
                        
                        const inst = api.customApiCall('sharp', content)[0]
                        if (!inst) throw new Error('missing "sharp" plugin')
                        
                        // prepare resize args
                        const resizeArgs = []
                        if (typeof optW === 'number' && !isNaN(optW)) resizeArgs.push(Math.round(optW))
                        else resizeArgs.push(undefined)
                        if (typeof optH === 'number' && !isNaN(optH)) resizeArgs.push(Math.round(optH))
                        
                        // call resize with fit inside to preserve aspect ratio
                        let pipeline = inst.resize(resizeArgs[0], resizeArgs[1], { fit: 'inside' }).rotate()
                        
                        const quality = Number(api.getConfig('quality') || 80)
                        let outBuf
                        if (fmt === 'jpeg') {
                            pipeline = pipeline.jpeg({ quality })
                            outBuf = Buffer.from(await pipeline.toBuffer())
                        } else {
                            // avif (AV1)
                            if (typeof pipeline.avif !== 'function') {
                                // if avif not supported, fallback to jpeg
                                pipeline = pipeline.jpeg({ quality })
                                outBuf = Buffer.from(await pipeline.toBuffer())
                            } else {
                                pipeline = pipeline.avif({ quality })
                                outBuf = Buffer.from(await pipeline.toBuffer())
                            }
                        }
                        const mime = fmt === 'jpeg' ? 'image/jpeg' : (pipeline.avif ? 'image/avif' : 'image/jpeg')
                        
                        // store in cached object
                        cached.variants = cached.variants || {}
                        cached.variants[variantKey(fmt, sizeLong, optW, optH)] = {
                            base64: outBuf.toString('base64'),
                            type: mime,
                            sizeLong,
                            created: Date.now()
                        }
                        
                        // update persisted cache metadata (don't block)
                        storeFileAttr(fileSource, K, Object.assign({ ts, thumbTs: new Date() }, cached)).catch(failSilently)
                        return { buf: outBuf, mime }
                    } catch (e) {
                        console.debug('thumbnails plugin: generate error', e && e.message || e, fileSource)
                        
                        // Dynamic fallback strategy - try scaling down by 50%
                        if (sizeLong > 32) { // Don't go below reasonable minimum
                            // Calculate a fallback size - use 50% reduction
                            const fallbackSize = Math.max(32, Math.floor(sizeLong * 0.5));
                            console.debug(`thumbnails: reducing size from ${sizeLong}px to ${fallbackSize}px and retrying`);
                            
                            // Scale width/height proportionally if provided
                            const ratio = fallbackSize / sizeLong;
                            const fallbackW = optW ? Math.round(optW * ratio) : undefined;
                            const fallbackH = optH ? Math.round(optH * ratio) : undefined;
                            
                            // Try again with smaller size
                            return generateAndStore(fmt, fallbackSize, fallbackW, fallbackH, recursionDepth + 1);
                        }
                        
                        return null;
                    }
                }

                // generate selected variant now
                const primary = await generateAndStore(outFormat, selectedLongSide, resizeW, resizeH)
                if (!primary) return error(501, 'thumbnail generation failed')
                ctx.type = primary.mime
                ctx.body = primary.buf

                // update top-level cache ts and persist (async)
                cached.ts = ts
                cached.thumbTs = new Date()
                storeFileAttr(fileSource, K, cached).catch(failSilently)

                // asynchronously generate other mip sizes with configured delays
                // generate all sizes up to original (and down to minSize) except the one we already produced.
                const initialDelay = (api.getConfig('initialDelay') || 60) * 1000; // in ms
                const intervalDelay = (api.getConfig('intervalDelay') || 10) * 1000; // in ms

                setTimeout(async () => {
                    try {
                        // recompute available mipSizes (in case orig was null earlier and now accessible)
                        const finalOrig = await getOriginalLongSide(content) || orig
                        const finalMipSizes = buildMipSizes(finalOrig ? finalOrig.long : originalLong)
                        const tasks = []
                        
                        // Filter out sizes that are already cached or equal to the one we just generated
                        for (const s of finalMipSizes) {
                            // Skip the size we just generated
                            if (s === selectedLongSide) continue
                            
                            // Skip sizes that are already in the cache
                            const key = variantKey(outFormat, s)
                            if (cached.variants && cached.variants[key]) {
                                console.debug(`thumbnails: async generation skipping already cached size ${s}px`)
                                continue
                            }
                            
                            // Only add tasks for sizes that need to be generated
                            tasks.push(async () => {
                                // Double-check it's not already in cache right before generating
                                // (might have been added by another request in the meantime)
                                if (cached.variants && cached.variants[key]) return null
                                
                                const res = await generateAndStore(outFormat, s, s, undefined)
                                return res
                            })
                        }
                        
                        console.debug(`thumbnails: async generation scheduled for ${tasks.length} sizes`)
                        
                        // run tasks one at a time with delay between each
                        for (let i = 0; i < tasks.length; i++) {
                            if (i > 0) {
                                // wait between tasks (not before first one)
                                await new Promise(resolve => setTimeout(resolve, intervalDelay))
                            }
                            
                            try {
                                // Run the task and check if it did something
                                const result = await tasks[i]()
                                
                                // Only persist cache after successful generation
                                if (result) {
                                    await storeFileAttr(fileSource, K, cached).catch(failSilently)
                                }
                            } catch (e) {
                                failSilently(e)
                            }
                        }
                        
                        // final persist + try to restore original file mtime
                        if (tasks.length > 0) {
                            cached.ts = ts
                            cached.thumbTs = new Date()
                            await storeFileAttr(fileSource, K, cached).catch(failSilently)
                            await utimes(fileSource, new Date(ts), new Date(ts)).catch(failSilently)
                        }
                    } catch (e) {
                        failSilently(e)
                    }
                }, initialDelay)

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
