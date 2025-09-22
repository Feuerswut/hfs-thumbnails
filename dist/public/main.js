'use strict';{
    const { h, t } = HFS
    const config = HFS.getPluginConfig()

    HFS.onEvent('entryIcon', ({ entry }) =>
            isSupported(entry) && h(ImgFallback, {
                fallback: () => entry.getDefaultIcon(),
                props: {
                    // request thumbnail with default format and default pixel size
                    src: entry.uri + '?get=thumb&s=' + encodeURIComponent(config.pixels) + '&format=' + encodeURIComponent(config.defaultFormat || 'avif'),
                    className: 'icon thumbnail',
                    loading: config.lazyLoading ? 'lazy' : undefined,
                    onMouseLeave() {
                        const p = document.getElementById('thumbnailsPreview')
                        if (p) p.innerHTML = ''
                    },
                    onMouseEnter(ev) {
                        if (!ev.target.closest('.dir')) return
                        // only show preview when not in tiles mode
                        if (!HFS.state.tile_size) {
                            const previewSize = calcPreviewSize(config.pixels, config.stepMultiplier)
                            const src = entry.uri + '?get=thumb&s=' + encodeURIComponent(previewSize) + '&format=' + encodeURIComponent(config.defaultFormat || 'avif')
                            document.getElementById('thumbnailsPreview').innerHTML = "<img src='" + src + "'/>"
                        }
                    },
                }
            })
            || config.videos && ['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(entry.ext) && h(ImgFallback, {
                fallback: () => entry.getDefaultIcon(),
                tag: 'video',
                props: {
                    src: entry.uri,
                    className: 'icon thumbnail',
                    disableRemotePlayback: true,
                    onMouseLeave() {
                        document.getElementById('thumbnailsPreview').innerHTML = ''
                    },
                    onMouseEnter() {
                        if (!HFS.state.tile_size) {
                            const previewSize = calcPreviewSize(config.pixels, config.stepMultiplier)
                            document.getElementById('thumbnailsPreview').innerHTML =
                                "<video src='" + entry.uri + "?get=thumb&s=" + encodeURIComponent(previewSize) + "&format=" + encodeURIComponent(config.defaultFormat || 'avif') + "'/>"
                        }
                    },
                }
            })
    )

    HFS.onEvent('afterList', () => "<div id='thumbnailsPreview'></div>" +
        "<style> #thumbnailsPreview { position: fixed; bottom: 0; right: 0; }" +
        "#thumbnailsPreview>* { max-height: 256px; max-width: 256px; }" +
        "</style>")

    function ImgFallback({ fallback, tag='img', props }) {
        const [err,setErr] = HFS.React.useState()
        return err ? fallback && h(fallback) : h(tag, Object.assign(props, {
            onError() { setErr(true) }
        }))
    }

    HFS.onEvent('fileMenu', ({ entry }) =>
        config.showTilesInMenu && !HFS.state.tile_size && isSupported(entry) && [{
            icon: '⊞',
            label: t("Enable tiles mode"),
            onClick() {
                HFS.state.tile_size = 10
                setTimeout(() => // give some time to see effect
                    HFS.dialogLib.alertDialog(t('thumbnails_switchBack', "To switch back, click Options")), 1000)
            }
        }] )

    function isSupported(entry) {
        return entry._th // calculated server-side
            || ['jpg','jpeg','png','webp','tiff','tif','gif','avif','svg'].includes(entry.ext)
            || HFS.emit('thumbnails_supported', { entry }).some(Boolean)
    }

    function calcPreviewSize(base, step) {
        // choose a reasonable preview size: one or two steps up but cap at 4096
        const s = Number(base) || 256
        const m = Number(step) || 2
        // prefer two steps up if step is small, otherwise one step
        let preview = Math.round(s * (m * (m <= 1.5 ? 1.5 : 1)))
        // if that is not much bigger, try s*m*m
        if (preview <= s * 1.25) preview = Math.round(s * m * m)
        if (preview < s) preview = s * 2
        if (preview > 4096) preview = 4096 //absolute limit upward for very large images
        return preview
    }
}
