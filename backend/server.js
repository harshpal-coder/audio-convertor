const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegStatic = require('ffmpeg-static');
const { ZipArchive } = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Root endpoint to verify server status
app.get('/', (req, res) => {
    res.json({ status: 'active', message: 'SonicTube API Server is running!' });
});

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// In-memory tasks store
const tasks = {};
const activeClients = {}; // SSE clients list

// Setup paths
const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir);
}
const ytDlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

console.log('--- SonicTube System Configuration ---');
console.log('FFmpeg Static Path:', ffmpegStatic);
console.log('yt-dlp Path:', ytDlpPath);
console.log('--------------------------------------');

// Helper to fetch playlist info using flat-playlist (extremely fast!)
function getPlaylistInfo(url) {
    return new Promise((resolve, reject) => {
        const args = [url, '--flat-playlist', '-J'];
        const ytDlpProcess = spawn(ytDlpPath, args);
        let stdout = '';
        let stderr = '';
        
        ytDlpProcess.stdout.on('data', (data) => { stdout += data.toString(); });
        ytDlpProcess.stderr.on('data', (data) => { stderr += data.toString(); });
        
        ytDlpProcess.on('close', (code) => {
            if (code === 0) {
                try {
                    const data = JSON.parse(stdout);
                    resolve(data);
                } catch (e) {
                    reject(new Error('Failed to parse playlist metadata: ' + e.message));
                }
            } else {
                reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
            }
        });
    });
}

// Helper to create a ZIP file from a directory
function createZipFromFolder(sourceFolder, zipFilePath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipFilePath);
        const archive = new ZipArchive({ zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', (err) => reject(err));

        archive.pipe(output);
        archive.directory(sourceFolder, false);
        archive.finalize();
    });
}

// Helper to push progress updates to active SSE clients
function emitProgress(taskId, data) {
    const clients = activeClients[taskId];
    if (clients) {
        clients.forEach(res => {
            try {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (err) {
                console.error(`Error sending SSE update for task ${taskId}:`, err.message);
            }
        });
    }
}

// Ensure yt-dlp is available on startup
async function setupYtDlp() {
    try {
        if (!fs.existsSync(ytDlpPath)) {
            console.log('yt-dlp binary not found! Downloading from GitHub releases...');
            await YTDlpWrap.downloadFromGithub(ytDlpPath);
            console.log('yt-dlp downloaded successfully!');
        } else {
            console.log('yt-dlp binary found.');
        }
        
        // Ensure the downloaded binary has executable permissions on non-Windows platforms (CORS/Linux hosting like Render)
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(ytDlpPath, '755');
                console.log('Set executable permissions (chmod +x) on yt-dlp binary.');
            } catch (chmodErr) {
                console.error('Failed to set executable permissions on yt-dlp:', chmodErr.message);
            }
        }

        const ytDlpWrap = new YTDlpWrap(ytDlpPath);
        const version = await ytDlpWrap.getVersion();
        console.log(`SonicTube ready! yt-dlp version: ${version.trim()}`);
    } catch (err) {
        console.error('Fatal error during startup binary setup:', err);
    }
}

// 1. Endpoint to retrieve YouTube video/playlist metadata
app.get('/api/info', async (req, res) => {
    const { url, type } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required.' });
    }

    const isPurePlaylist = url.includes('/playlist') && url.includes('list=');
    const hasPlaylist = url.includes('list=');
    const shouldFetchPlaylist = type === 'playlist' || (isPurePlaylist && type !== 'video');

    if (shouldFetchPlaylist) {
        try {
            console.log(`Fetching playlist metadata for: ${url}`);
            const playlistData = await getPlaylistInfo(url);
            
            const responseData = {
                isPlaylist: true,
                id: playlistData.id,
                title: playlistData.title,
                uploader: playlistData.uploader || playlistData.channel || 'Unknown Creator',
                playlistCount: playlistData.entries ? playlistData.entries.length : 0,
                thumbnail: playlistData.thumbnails && playlistData.thumbnails.length > 0 
                    ? playlistData.thumbnails[playlistData.thumbnails.length - 1].url 
                    : (playlistData.entries && playlistData.entries.length > 0 && playlistData.entries[0].thumbnails && playlistData.entries[0].thumbnails.length > 0
                        ? playlistData.entries[0].thumbnails[playlistData.entries[0].thumbnails.length - 1].url
                        : ''),
                description: playlistData.description ? playlistData.description.slice(0, 200) + '...' : '',
                entries: (playlistData.entries || []).map(entry => ({
                    id: entry.id,
                    title: entry.title || 'Untitled Video',
                    uploader: entry.uploader || entry.channel || '',
                    duration: entry.duration || 0
                }))
            };
            return res.json(responseData);
        } catch (err) {
            console.error('Error fetching playlist info:', err.message);
            return res.status(500).json({ error: `Failed to retrieve playlist metadata: ${err.message}` });
        }
    }

    // Default to fetching single video info
    try {
        const ytDlpWrap = new YTDlpWrap(ytDlpPath);
        const metadata = await ytDlpWrap.getVideoInfo(url);
        
        const responseData = {
            isPlaylist: false,
            id: metadata.id,
            title: metadata.title,
            uploader: metadata.uploader || metadata.channel || 'Unknown Artist',
            duration: metadata.duration, // in seconds
            thumbnail: metadata.thumbnail || (metadata.thumbnails && metadata.thumbnails.length > 0 ? metadata.thumbnails[metadata.thumbnails.length - 1].url : ''),
            description: metadata.description ? metadata.description.slice(0, 200) + '...' : '',
            viewCount: metadata.view_count || 0,
            hasPlaylist: hasPlaylist,
            playlistUrl: hasPlaylist ? url : null
        };
        
        return res.json(responseData);
    } catch (err) {
        console.error('Error fetching video info:', err.message);
        return res.status(500).json({ error: `Failed to retrieve video metadata: ${err.message}` });
    }
});

// 2. Endpoint to initiate a background download and conversion task
app.post('/api/convert', (req, res) => {
    const { url, format = 'mp3', quality = '320k', title, artist, isPlaylist = false } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required.' });
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const ext = format === 'm4a' ? 'm4a' : 'mp3';
    
    // Initialize task record
    tasks[taskId] = {
        id: taskId,
        isPlaylist: !!isPlaylist,
        status: 'downloading',
        progress: 0,
        speed: '0 B/s',
        eta: '--:--',
        size: '0 B',
        title: title || (isPlaylist ? 'playlist' : 'audio'),
        artist: artist || 'SonicTube',
        format: ext,
        playlistCount: 0,
        currentItemIndex: 0,
        currentItemTitle: '',
        error: null
    };

    // Construct yt-dlp arguments
    const playlistDir = path.join(downloadsDir, taskId);
    let outputTemplate;
    
    if (isPlaylist) {
        if (!fs.existsSync(playlistDir)) {
            fs.mkdirSync(playlistDir, { recursive: true });
        }
        outputTemplate = path.join(playlistDir, '%(playlist_index)s - %(title)s.%(ext)s');
    } else {
        outputTemplate = path.join(downloadsDir, `${taskId}.%(ext)s`);
    }
    
    const args = [
        url,
        '-x',
        '--audio-format', ext,
        '--ffmpeg-location', ffmpegStatic,
        '-o', outputTemplate
    ];

    if (isPlaylist) {
        args.push('--ignore-errors'); // Don't crash the whole playlist download if a video fails
    } else {
        args.push('--no-playlist'); // Convert only single video
    }

    // Map bitrate selections
    if (ext === 'mp3') {
        const bitrateMap = {
            '320k': '0', // Best VBR
            '256k': '2',
            '128k': '5'
        };
        const qualityArg = bitrateMap[quality] || '0';
        args.push('--audio-quality', qualityArg);
    } else {
        // M4A format settings
        args.push('--audio-quality', '0'); // highest quality
    }

    console.log(`Spawning download process for task: ${taskId} (Playlist: ${isPlaylist})`);
    console.log(`Executing: yt-dlp ${args.join(' ')}`);

    const ytDlpProcess = spawn(ytDlpPath, args);
    tasks[taskId].process = ytDlpProcess;

    // Track standard output for download progress
    ytDlpProcess.stdout.on('data', (data) => {
        const text = data.toString();
        
        // 1. Check if downloading a playlist item
        const playlistItemRegex = /\[download\]\s+Downloading\s+item\s+(\d+)\s+of\s+(\d+)/i;
        const itemMatch = text.match(playlistItemRegex);
        if (itemMatch) {
            tasks[taskId].currentItemIndex = parseInt(itemMatch[1]);
            tasks[taskId].playlistCount = parseInt(itemMatch[2]);
        }

        // 2. Check destination path to update current item title
        const destRegex = /\[download\]\s+Destination:\s+(.+)/i;
        const destMatch = text.match(destRegex);
        if (destMatch) {
            const destPath = destMatch[1].trim();
            let baseName = path.basename(destPath);
            // Remove digits prefix like "1 - Title" and final extension
            baseName = baseName.replace(/^\d+\s+-\s+/, '').replace(/\.[^/.]+$/, '');
            tasks[taskId].currentItemTitle = baseName;
        }

        // 3. Match download progress: "[download]  10.5% of 15.30MiB at  3.45MiB/s ETA 00:03"
        const progressRegex = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)/;
        const match = text.match(progressRegex);
        
        if (match) {
            const progress = parseFloat(match[1]);
            const size = match[2];
            const speed = match[3];
            const eta = match[4];
            
            tasks[taskId].status = 'downloading';
            tasks[taskId].size = size;
            tasks[taskId].speed = speed;
            tasks[taskId].eta = eta;
            
            if (isPlaylist) {
                const currentIdx = tasks[taskId].currentItemIndex || 1;
                const totalCount = tasks[taskId].playlistCount || 1;
                // overall progress goes from 0 to 99 during downloads
                const overallProgress = Math.min(99, Math.round(((currentIdx - 1) * 100 + progress) / totalCount));
                tasks[taskId].progress = overallProgress;
                
                emitProgress(taskId, {
                    status: 'downloading',
                    progress: overallProgress,
                    size,
                    speed,
                    eta,
                    isPlaylist: true,
                    playlistCount: totalCount,
                    currentItemIndex: currentIdx,
                    currentItemTitle: tasks[taskId].currentItemTitle
                });
            } else {
                tasks[taskId].progress = progress;
                emitProgress(taskId, {
                    status: 'downloading',
                    progress,
                    size,
                    speed,
                    eta,
                    isPlaylist: false
                });
            }
        } else if (text.includes('[ExtractAudio]') || text.includes('[ffmpeg]')) {
            // Conversion/processing phase started
            tasks[taskId].status = 'converting';
            
            if (isPlaylist) {
                const currentIdx = tasks[taskId].currentItemIndex || 1;
                const totalCount = tasks[taskId].playlistCount || 1;
                const overallProgress = Math.min(99, Math.round(((currentIdx - 1) * 100 + 95) / totalCount));
                tasks[taskId].progress = overallProgress;
                
                emitProgress(taskId, {
                    status: 'converting',
                    progress: overallProgress,
                    isPlaylist: true,
                    playlistCount: totalCount,
                    currentItemIndex: currentIdx,
                    currentItemTitle: tasks[taskId].currentItemTitle
                });
            } else {
                tasks[taskId].progress = 95;
                emitProgress(taskId, {
                    status: 'converting',
                    progress: 95,
                    isPlaylist: false
                });
            }
        }
    });

    // Capture standard error stream
    ytDlpProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        console.error(`[yt-dlp stderr - ${taskId}]:`, text);
        
        // Save the first major error signature if encountered (ignore JS runtime deprecation warning)
        if (text.toLowerCase().includes('error:') && !text.toLowerCase().includes('js-runtimes') && !tasks[taskId].error) {
            tasks[taskId].error = text.split('ERROR:').pop().trim();
        }
    });

    // Handle process termination
    ytDlpProcess.on('close', (code) => {
        console.log(`Task ${taskId} completed with exit code: ${code}`);
        delete tasks[taskId].process; // Remove process reference

        const filesCount = fs.existsSync(playlistDir) ? fs.readdirSync(playlistDir).length : 0;

        if (code === 0 || (isPlaylist && filesCount > 0)) {
            if (isPlaylist) {
                tasks[taskId].status = 'converting';
                emitProgress(taskId, {
                    status: 'converting',
                    progress: 98,
                    isPlaylist: true,
                    currentItemTitle: 'Compiling files into ZIP archive...'
                });

                const zipFilePath = path.join(downloadsDir, `${taskId}.zip`);
                createZipFromFolder(playlistDir, zipFilePath)
                    .then(() => {
                        // Delete directory recursively
                        fs.rm(playlistDir, { recursive: true, force: true }, (err) => {
                            if (err) console.error('Error deleting playlist directory:', err);
                        });

                        tasks[taskId].status = 'completed';
                        tasks[taskId].progress = 100;
                        tasks[taskId].filePath = zipFilePath;
                        
                        emitProgress(taskId, {
                            status: 'completed',
                            progress: 100,
                            isPlaylist: true,
                            downloadUrl: `/api/download/${taskId}`
                        });
                    })
                    .catch((zipErr) => {
                        console.error('ZIP compilation error:', zipErr);
                        tasks[taskId].status = 'failed';
                        tasks[taskId].error = 'Failed to create ZIP package: ' + zipErr.message;
                        emitProgress(taskId, {
                            status: 'failed',
                            isPlaylist: true,
                            error: tasks[taskId].error
                        });
                    });
            } else {
                const finalFilePath = path.join(downloadsDir, `${taskId}.${ext}`);
                if (fs.existsSync(finalFilePath)) {
                    tasks[taskId].status = 'completed';
                    tasks[taskId].progress = 100;
                    tasks[taskId].filePath = finalFilePath;
                    
                    emitProgress(taskId, {
                        status: 'completed',
                        progress: 100,
                        downloadUrl: `/api/download/${taskId}`
                    });
                } else {
                    tasks[taskId].status = 'failed';
                    tasks[taskId].error = 'Audio file was not generated properly.';
                    emitProgress(taskId, {
                        status: 'failed',
                        error: 'Audio file was not generated properly.'
                    });
                }
            }
        } else {
            tasks[taskId].status = 'failed';
            const errorMsg = tasks[taskId].error || `Extraction failed. yt-dlp exited with error code ${code}.`;
            tasks[taskId].error = errorMsg;
            emitProgress(taskId, {
                status: 'failed',
                error: errorMsg
            });
        }
    });

    // Return the task ID immediately so frontend can listen to progress
    return res.json({ taskId });
});

// 3. Server-Sent Events (SSE) progress endpoint
app.get('/api/progress/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task) {
        return res.status(404).json({ error: 'Task not found or expired.' });
    }

    // Set SSE-specific headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Flush the headers to establish connection

    // Send immediate initial state
    res.write(`data: ${JSON.stringify({
        status: task.status,
        progress: task.progress,
        size: task.size,
        speed: task.speed,
        eta: task.eta,
        error: task.error,
        isPlaylist: task.isPlaylist,
        playlistCount: task.playlistCount,
        currentItemIndex: task.currentItemIndex,
        currentItemTitle: task.currentItemTitle,
        downloadUrl: task.status === 'completed' ? `/api/download/${taskId}` : null
    })}\n\n`);

    // If already resolved, close the connection
    if (task.status === 'completed' || task.status === 'failed') {
        return res.end();
    }

    // Register active SSE listener
    if (!activeClients[taskId]) {
        activeClients[taskId] = [];
    }
    activeClients[taskId].push(res);

    // Clean up on disconnect
    req.on('close', () => {
        if (activeClients[taskId]) {
            activeClients[taskId] = activeClients[taskId].filter(client => client !== res);
            if (activeClients[taskId].length === 0) {
                delete activeClients[taskId];
            }
        }
    });
});

// 4. Download endpoint that streams the completed audio with the correct file name
app.get('/api/download/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task || task.status !== 'completed' || !task.filePath) {
        return res.status(404).send('File not found, task was not completed, or link has expired.');
    }

    if (!fs.existsSync(task.filePath)) {
        return res.status(404).send('Audio file does not exist on disk.');
    }

    // Standardize filename
    const safeTitle = task.title.replace(/[\\/:*?"<>|]/g, ''); // strip illegal characters
    
    if (task.isPlaylist) {
        const downloadName = `${safeTitle}.zip`;
        console.log(`Streaming playlist download zip: "${downloadName}"`);
        
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
        res.setHeader('Content-Type', 'application/zip');
    } else {
        const ext = task.format;
        const downloadName = `${task.artist} - ${safeTitle}.${ext}`;
        console.log(`Streaming single video download: "${downloadName}"`);
        
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
        res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4');
    }

    // Stream the file
    const fileStream = fs.createReadStream(task.filePath);
    fileStream.pipe(res);
});

// Automated Garbage Collection: Check and delete files/folders older than 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const EXPIRY_THRESHOLD = 30 * 60 * 1000; // 30 minutes

setInterval(() => {
    const now = Date.now();
    
    fs.readdir(downloadsDir, (err, files) => {
        if (err) {
            console.error('Cleanup error listing files:', err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            
            fs.stat(filePath, (err, stats) => {
                if (err) return;

                if (now - stats.mtimeMs > EXPIRY_THRESHOLD) {
                    if (stats.isDirectory()) {
                        fs.rm(filePath, { recursive: true, force: true }, (err) => {
                            if (err) {
                                console.error(`Error deleting expired directory ${file}:`, err.message);
                            } else {
                                console.log(`Auto-cleanup deleted expired directory: ${file}`);
                                if (tasks[file]) {
                                    delete tasks[file];
                                }
                            }
                        });
                    } else {
                        fs.unlink(filePath, (err) => {
                            if (err) {
                                console.error(`Error deleting expired file ${file}:`, err.message);
                            } else {
                                console.log(`Auto-cleanup deleted expired file: ${file}`);
                                
                                const taskId = path.basename(file, path.extname(file));
                                if (tasks[taskId]) {
                                    delete tasks[taskId];
                                }
                            }
                        });
                    }
                }
            });
        });
    });
}, CLEANUP_INTERVAL);

// Start the server after checking binaries
app.listen(PORT, async () => {
    console.log(`Server started on http://localhost:${PORT}`);
    await setupYtDlp();
});
