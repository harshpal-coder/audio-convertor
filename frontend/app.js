/* ==========================================================================
   SonicTube - Core Frontend Engine (ES6 Client-side Controller)
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // -------------------------------------------------------------
    // DOM Element Selectors
    // -------------------------------------------------------------
    
    // State Views
    const stateInput = document.getElementById('state-input');
    const stateConfig = document.getElementById('state-config');
    const stateProgress = document.getElementById('state-progress');
    const stateSuccess = document.getElementById('state-success');
    const views = [stateInput, stateConfig, stateProgress, stateSuccess];

    // Inputs & Forms
    const urlForm = document.getElementById('url-form');
    const youtubeUrlInput = document.getElementById('youtube-url');
    const clearBtn = document.getElementById('clear-btn');
    const fetchBtn = document.getElementById('fetch-btn');
    const configBackBtn = document.getElementById('config-back-btn');

    // Config Screen Elements
    const videoThumbnail = document.getElementById('video-thumbnail');
    const videoDuration = document.getElementById('video-duration');
    const rawVideoTitle = document.getElementById('raw-video-title');
    const rawVideoChannel = document.getElementById('raw-video-channel');
    
    const formatSelectors = document.querySelectorAll('input[name="format"]');
    const qualityWrapper = document.getElementById('quality-wrapper');
    const qualitySelectors = document.querySelectorAll('input[name="quality"]');
    
    // Playlist UI Elements
    const playlistPromptBanner = document.getElementById('playlist-prompt-banner');
    const convertPlaylistInsteadBtn = document.getElementById('convert-playlist-instead-btn');
    const metadataSection = document.getElementById('metadata-section');
    const playlistSection = document.getElementById('playlist-section');
    const playlistTrackCount = document.getElementById('playlist-track-count');
    const playlistTracksList = document.getElementById('playlist-tracks-list');
    
    const metaTitleInput = document.getElementById('meta-title');
    const metaArtistInput = document.getElementById('meta-artist');
    const convertBtn = document.getElementById('convert-btn');

    // Progress Screen Elements
    const progressRingBar = document.querySelector('.progress-ring-bar');
    const percentNum = document.getElementById('percent-num');
    const statusTitle = document.getElementById('status-title');
    const statusSubtitle = document.getElementById('status-subtitle');
    const metricSpeed = document.getElementById('metric-speed');
    const metricEta = document.getElementById('metric-eta');
    const metricSize = document.getElementById('metric-size');
    const waveBars = document.querySelectorAll('.wave-visualizer .bar');

    // Success Screen Elements
    const successFileIcon = document.getElementById('success-file-icon');
    const successFileLabel = document.getElementById('success-file-label');
    const successFileName = document.getElementById('success-file-name');
    const successFormat = document.getElementById('success-format');
    const successSize = document.getElementById('success-size');
    const downloadLink = document.getElementById('download-link');
    const resetBtn = document.getElementById('reset-btn');

    // Toast Error elements
    const errorToast = document.getElementById('error-toast');
    const toastErrText = document.getElementById('toast-err-text');
    const closeToastBtn = document.getElementById('close-toast-btn');

    // -------------------------------------------------------------
    // Core Application State
    // -------------------------------------------------------------
    const API_BASE = window.location.port === '3000' 
        ? '' 
        : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
            ? 'http://localhost:3000' 
            : 'https://your-production-backend-url.com'); // Replace with your production backend URL (e.g. on Render or Railway)
    let currentVideoData = null;
    let sseConnection = null;
    const ringCircumference = 439.8; // 2 * pi * 70 (r=70 in SVG)

    // -------------------------------------------------------------
    // Utility Helpers
    // -------------------------------------------------------------

    // Transition between view states smoothly
    function changeState(targetState) {
        views.forEach(view => {
            view.classList.remove('active');
            view.style.display = 'none';
        });

        let targetEl;
        switch(targetState) {
            case 'input': targetEl = stateInput; break;
            case 'config': targetEl = stateConfig; break;
            case 'progress': targetEl = stateProgress; break;
            case 'success': targetEl = stateSuccess; break;
        }

        if (targetEl) {
            targetEl.style.display = 'flex';
            // Trigger reflow for transition
            void targetEl.offsetWidth;
            targetEl.classList.add('active');
        }
    }

    // Format seconds into digital clock style (e.g., 135 -> 02:15)
    function formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const pad = (num) => String(num).padStart(2, '0');

        if (hrs > 0) {
            return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
        }
        return `${pad(mins)}:${pad(secs)}`;
    }

    // Clean messy YouTube titles for premium MP3 tagging (UX delight!)
    function cleanYoutubeTitle(title) {
        if (!title) return '';
        
        // Remove brackets/parentheses containing "Official", "Video", "Lyrics", "4K", etc.
        let cleaned = title.replace(/\s*[\(\[][^\]\)]*(?:official|video|audio|lyrics|4k|hd|sd|hq|remastered|cover|music\s+video|visualizer|subtitles)[^\]\)]*[\)\]]/gi, '');
        
        // Remove common vertical separator tags
        cleaned = cleaned.replace(/\s*\|\s*Official\s*(?:Music\s*)?Video/gi, '');
        cleaned = cleaned.replace(/\s*\|\s*Clean\s*Audio/gi, '');
        cleaned = cleaned.replace(/\s+-\s+Topic$/i, '');
        
        // Clean multiple spaces and trim
        return cleaned.replace(/\s+/g, ' ').trim();
    }

    // Set SVG progress ring stroke offset
    function setRingProgress(percent) {
        const offset = ringCircumference - (percent / 100) * ringCircumference;
        progressRingBar.style.strokeDashoffset = offset;
        percentNum.textContent = Math.round(percent);
    }

    // Show custom toast notification
    function showToast(message) {
        toastErrText.textContent = message;
        errorToast.classList.add('show');
        
        // Auto-close toast after 6 seconds
        setTimeout(() => {
            errorToast.classList.remove('show');
        }, 6000);
    }

    // Parse standard text input URL to verify YouTube structure (supports videos & playlists)
    function isValidYoutubeUrl(url) {
        // Match standard watch URLs, short y2u.be links, embed links, and playlist URLs
        const videoRegex = /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|playlist\?list=))((\w|-){11,34})(?:\S+)?$/;
        const rawPlaylistRegex = /[&?]list=([^&]+)/;
        return videoRegex.test(url) || rawPlaylistRegex.test(url);
    }

    // -------------------------------------------------------------
    // Event Listeners & Interactive Logic
    // -------------------------------------------------------------

    // URL input input listener (show/hide clear button)
    youtubeUrlInput.addEventListener('input', () => {
        const url = youtubeUrlInput.value.trim();
        clearBtn.style.display = url.length > 0 ? 'flex' : 'none';
    });

    // Clear input action
    clearBtn.addEventListener('click', () => {
        youtubeUrlInput.value = '';
        clearBtn.style.display = 'none';
        youtubeUrlInput.focus();
    });

    // Playlist banner button triggers playlist load
    convertPlaylistInsteadBtn.addEventListener('click', () => {
        if (currentVideoData && currentVideoData.playlistUrl) {
            youtubeUrlInput.value = currentVideoData.playlistUrl;
            playlistPromptBanner.style.display = 'none';
            // Trigger fetch search
            urlForm.dispatchEvent(new Event('submit'));
        }
    });

    // 1. Fetch metadata form submit
    urlForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = youtubeUrlInput.value.trim();

        if (!isValidYoutubeUrl(url)) {
            showToast('Invalid YouTube Link. Please make sure you paste a correct YouTube video or playlist URL.');
            return;
        }

        // Disable interface during fetch loading state
        youtubeUrlInput.disabled = true;
        fetchBtn.disabled = true;
        fetchBtn.querySelector('.btn-text').style.display = 'none';
        fetchBtn.querySelector('.btn-loader').style.display = 'inline-block';
        playlistPromptBanner.style.display = 'none';

        try {
            const response = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
            const data = await response.json();

            if (!response.ok || data.error) {
                throw new Error(data.error || 'Server returned an error fetching YouTube details.');
            }

            // Successfully fetched metadata! Set global state
            currentVideoData = data;
            currentVideoData.originalUrl = url;

            // Populate Config State layout
            videoThumbnail.src = data.thumbnail;
            rawVideoTitle.textContent = data.title;
            rawVideoChannel.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${data.uploader}`;

            if (data.isPlaylist) {
                // If it's a full playlist
                videoDuration.textContent = `${data.playlistCount} Tracks`;
                
                // Toggle sections: hide tags, show tracks
                metadataSection.style.display = 'none';
                playlistSection.style.display = 'flex';
                playlistTrackCount.textContent = data.playlistCount;
                
                // Populate the scroll list of songs
                playlistTracksList.innerHTML = '';
                (data.entries || []).forEach((entry, idx) => {
                    const item = document.createElement('div');
                    item.className = 'playlist-track-item';
                    item.innerHTML = `
                        <span class="track-number">${idx + 1}</span>
                        <span class="track-title" title="${entry.title}">${entry.title}</span>
                        <span class="track-duration">${formatDuration(entry.duration)}</span>
                    `;
                    playlistTracksList.appendChild(item);
                });
                
                convertBtn.innerHTML = `<i class="fa-solid fa-circle-down"></i> Convert Playlist to ZIP`;
            } else {
                // If it's a single video
                videoDuration.textContent = formatDuration(data.duration);
                
                // Toggle sections: show tags, hide tracks
                metadataSection.style.display = 'flex';
                playlistSection.style.display = 'none';
                
                // Clean Title & Artist for metadata tagging prefill
                let defaultArtist = data.uploader.replace(/VEVO$/i, '').trim(); // Remove VEVO tags
                let defaultTitle = cleanYoutubeTitle(data.title);
                
                // Check if title has a hyphen (usually artist - title format)
                if (defaultTitle.includes(' - ')) {
                    const parts = defaultTitle.split(' - ');
                    defaultArtist = parts[0].trim();
                    defaultTitle = parts[1].trim();
                }

                metaTitleInput.value = defaultTitle;
                metaArtistInput.value = defaultArtist;
                
                // Offer option to convert full playlist if detected
                if (data.hasPlaylist && data.playlistUrl) {
                    playlistPromptBanner.style.display = 'flex';
                }

                convertBtn.innerHTML = `<i class="fa-solid fa-circle-down"></i> Convert to Audio`;
            }

            // Shift states smoothly
            changeState('config');

        } catch (err) {
            console.error('Metadata Fetch Error:', err);
            showToast(err.message || 'Failed to connect to SonicTube engine. Make sure the backend is active.');
        } finally {
            // Restore UI state
            youtubeUrlInput.disabled = false;
            fetchBtn.disabled = false;
            fetchBtn.querySelector('.btn-text').style.display = 'inline-block';
            fetchBtn.querySelector('.btn-loader').style.display = 'none';
        }
    });

    // Back button from config
    configBackBtn.addEventListener('click', () => {
        currentVideoData = null;
        playlistPromptBanner.style.display = 'none';
        changeState('input');
    });

    // Toggle segment pills visual state
    function bindSegmentedControls(selectorId, wrapperToToggle = null) {
        const selector = document.getElementById(selectorId);
        const pills = selector.querySelectorAll('.segment-pill');
        
        pills.forEach(pill => {
            const radio = pill.querySelector('input[type="radio"]');
            
            pill.addEventListener('click', () => {
                pills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                radio.checked = true;

                // Handle M4A quality section hiding
                if (wrapperToToggle) {
                    if (radio.value === 'm4a') {
                        wrapperToToggle.style.opacity = '0.35';
                        wrapperToToggle.style.pointerEvents = 'none';
                    } else {
                        wrapperToToggle.style.opacity = '1';
                        wrapperToToggle.style.pointerEvents = 'auto';
                    }
                }
            });
        });
    }

    bindSegmentedControls('format-selector', qualityWrapper);
    bindSegmentedControls('quality-selector');

    // Close error Toast
    closeToastBtn.addEventListener('click', () => {
        errorToast.classList.remove('show');
    });

    // 2. Start conversion execution
    convertBtn.addEventListener('click', async () => {
        if (!currentVideoData) return;

        // Retrieve settings
        const selectedFormat = document.querySelector('input[name="format"]:checked').value;
        const selectedQuality = document.querySelector('input[name="quality"]:checked').value;
        
        // Prepare request body
        const reqPayload = {
            url: currentVideoData.originalUrl,
            format: selectedFormat,
            quality: selectedQuality,
            isPlaylist: !!currentVideoData.isPlaylist
        };

        if (!currentVideoData.isPlaylist) {
            reqPayload.title = metaTitleInput.value.trim() || currentVideoData.title;
            reqPayload.artist = metaArtistInput.value.trim() || currentVideoData.uploader;
        } else {
            reqPayload.title = currentVideoData.title;
            reqPayload.artist = currentVideoData.uploader || 'SonicTube Playlist';
        }

        // Transition immediately to progress screen
        changeState('progress');
        setRingProgress(0);
        statusTitle.textContent = 'Initializing engine...';
        statusSubtitle.textContent = 'Queueing download thread';
        
        // Reset metrics
        metricSpeed.textContent = '0.0 MB/s';
        metricEta.textContent = '00:00';
        metricSize.textContent = '-- MB';

        // Animate wave lines gently on init
        waveBars.forEach(bar => {
            bar.style.animationPlayState = 'paused';
            bar.style.height = '6px';
        });

        try {
            const response = await fetch(`${API_BASE}/api/convert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqPayload)
            });
            const data = await response.json();

            if (!response.ok || data.error) {
                throw new Error(data.error || 'Failed to initialize conversion task.');
            }

            const { taskId } = data;

            // Establish real-time Server-Sent Events stream for task tracking
            establishSseProgress(taskId, reqPayload);

        } catch (err) {
            console.error('Convert Initializing Error:', err);
            showToast(err.message || 'Server failed to start downloading.');
            changeState('config'); // Return back to configuration card
        }
    });

    // Establish Server-Sent Events (SSE) listener
    function establishSseProgress(taskId, originalSettings) {
        if (sseConnection) {
            sseConnection.close();
        }

        // Connect to server event stream
        sseConnection = new EventSource(`${API_BASE}/api/progress/${taskId}`);

        // Run animations on the equalizer
        waveBars.forEach(bar => {
            bar.style.animationPlayState = 'running';
        });

        sseConnection.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.error) {
                sseConnection.close();
                showToast(`Conversion failed: ${data.error}`);
                changeState('config');
                return;
            }

            switch (data.status) {
                case 'downloading':
                    if (data.isPlaylist) {
                        statusTitle.textContent = `Downloading Tracks... (${data.currentItemIndex} of ${data.playlistCount})`;
                        statusSubtitle.textContent = `Current: ${data.currentItemTitle || 'Analyzing playlist entries...'}`;
                    } else {
                        statusTitle.textContent = 'Downloading Audio Stream...';
                        statusSubtitle.textContent = 'Extracting audio packets from YouTube';
                    }
                    
                    // Update progress ring and text
                    setRingProgress(data.progress);
                    
                    // Update metrics
                    metricSpeed.textContent = data.speed || '0.0 MB/s';
                    metricEta.textContent = data.eta || '00:00';
                    metricSize.textContent = data.isPlaylist ? `${data.playlistCount} Items` : (data.size || '-- MB');
                    
                    // Control equalizer animation speed based on download speed
                    const hasHighSpeed = data.speed && !data.speed.includes('K');
                    waveBars.forEach(bar => {
                        bar.style.animationDuration = hasHighSpeed ? '0.6s' : '1.2s';
                    });
                    break;

                case 'converting':
                    if (data.isPlaylist) {
                        statusTitle.textContent = 'Assembling Playlist ZIP Archive...';
                        statusSubtitle.textContent = data.currentItemTitle || 'Compiling and compressing track items';
                    } else {
                        statusTitle.textContent = 'Encoding High-Fidelity Audio...';
                        statusSubtitle.textContent = 'Processing bitrate conversion via FFmpeg';
                    }
                    
                    // Update progress
                    setRingProgress(data.progress || 95);
                    
                    metricSpeed.textContent = 'Encoding...';
                    metricEta.textContent = 'Almost done';
                    
                    // Run equalizer fast during compression
                    waveBars.forEach(bar => {
                        bar.style.animationDuration = '0.4s';
                    });
                    break;

                case 'completed':
                    sseConnection.close();
                    
                    if (data.isPlaylist) {
                        // Success card details for Playlist ZIP
                        successFileIcon.className = 'fa-solid fa-file-zipper file-zip-icon';
                        successFileLabel.textContent = 'Ready ZIP Archive';
                        successFileLabel.style.color = '#eab308'; // match zip gold
                        
                        const safeTitle = originalSettings.title.replace(/[\\/:*?"<>|]/g, '');
                        successFileName.textContent = `${safeTitle}.zip`;
                        successFormat.textContent = `ZIP Package (${originalSettings.format.toUpperCase()} Tracks)`;
                        successSize.textContent = `${currentVideoData.playlistCount} tracks included`;
                        
                        // Setup direct download trigger link
                        downloadLink.href = `${API_BASE}${data.downloadUrl}`;
                        downloadLink.download = `${safeTitle}.zip`;
                    } else {
                        // Success card details for Single Audio
                        successFileIcon.className = 'fa-solid fa-file-audio file-music-icon';
                        successFileLabel.textContent = 'Ready File';
                        successFileLabel.style.color = ''; // reset to default green/emerald
                        
                        const extLabel = originalSettings.format.toUpperCase();
                        const qualityLabel = originalSettings.format === 'mp3' ? ` (${originalSettings.quality.replace('k', ' kbps')})` : '';
                        
                        successFileName.textContent = `${originalSettings.artist} - ${originalSettings.title}.${originalSettings.format}`;
                        successFormat.textContent = `${extLabel}${qualityLabel}`;
                        successSize.textContent = metricSize.textContent !== '-- MB' ? metricSize.textContent : 'Compressed';
                        
                        // Setup direct download trigger link
                        downloadLink.href = `${API_BASE}${data.downloadUrl}`;
                        downloadLink.download = `${originalSettings.artist} - ${originalSettings.title}.${originalSettings.format}`;
                    }

                    // Transition to complete stage
                    changeState('success');
                    break;

                case 'failed':
                    sseConnection.close();
                    showToast(data.error || 'Audio extraction was aborted.');
                    changeState('config');
                    break;
            }
        };

        sseConnection.onerror = (err) => {
            console.error('SSE connection error:', err);
            sseConnection.close();
            
            // Connection drops are sometimes expected as streams finish. Let's poll as backup or fail gracefully.
            showToast('Lost connection to server progress socket. Check server log.');
            changeState('config');
        };
    }

    // Reset app for next conversion
    resetBtn.addEventListener('click', () => {
        currentVideoData = null;
        youtubeUrlInput.value = '';
        clearBtn.style.display = 'none';
        playlistPromptBanner.style.display = 'none';
        changeState('input');
        
        // Focus the URL input for immediate next task
        setTimeout(() => {
            youtubeUrlInput.focus();
        }, 100);
    });
});
