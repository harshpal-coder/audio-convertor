const fs = require('fs');
const path = require('path');
const YTDlpWrap = require('yt-dlp-wrap').default;

const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir);
}

const ytDlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

console.log('Target path:', ytDlpPath);
console.log('Platform:', process.platform);

async function setup() {
    try {
        if (!fs.existsSync(ytDlpPath)) {
            console.log('yt-dlp not found. Downloading latest version from GitHub...');
            // Download the binary
            await YTDlpWrap.downloadFromGithub(ytDlpPath);
            console.log('Download complete!');
        } else {
            console.log('yt-dlp binary already exists.');
        }

        const ytDlpWrap = new YTDlpWrap(ytDlpPath);
        console.log('Getting version...');
        const version = await ytDlpWrap.getVersion();
        console.log('yt-dlp version:', version);

        console.log('Getting metadata for a test video...');
        const metadata = await ytDlpWrap.getVideoInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        console.log('Title:', metadata.title);
        console.log('Duration:', metadata.duration, 'seconds');
        console.log('Thumbnail:', metadata.thumbnail);
    } catch (err) {
        console.error('Error during setup or test:', err);
    }
}

setup();
