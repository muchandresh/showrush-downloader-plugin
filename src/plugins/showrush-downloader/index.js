/**
 * Showrush Universal Stream & HLS Downloader Plugin
 * Ecosystem: Showrush Native
 * Capabilities: ['downloader']
 */

const activeTasks = new Map(); // taskId -> { paused: boolean, cancelled: boolean, abortController: AbortController }

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec > 1024 * 1024) {
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  }
  if (bytesPerSec > 1024) {
    return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
  }
  return Math.round(bytesPerSec) + ' B/s';
}

function resolveUrl(relativeUrl, baseUrl) {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return relativeUrl;
  }
}

function sanitizeFilename(title) {
  return (title || 'media_download').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function triggerDownloadPrompt(blobUrl, filename) {
  try {
    if (typeof document === 'undefined') return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch (_) {}
    }, 1000);
  } catch (err) {
    console.warn('[Downloader] Browser save trigger notice:', err);
  }
}

return {
  id: "com.showrush.downloader",
  name: "Showrush Stream & HLS Downloader",
  version: "1.0.0",
  author: "Showrush Core Team",
  description: "High-performance offline downloader for movies & TV episodes.",
  category: "plugin",
  capabilities: ["downloader"],
  types: ["movie", "tv", "anime"],
  settings: {
    concurrency: 3,
    autoOpenOffline: true
  },

  async getStreams() {
    // Utility plugin: does not provide content streams
    return [];
  },

  /**
   * Main download hook invoked by PluginManager
   * @param {import('@/types/plugin').DownloadTask} task
   * @param {(update: Partial<DownloadTask>) => void} onProgress
   */
  async downloadStream(task, onProgress) {
    const taskId = task.id;
    const abortCtrl = new AbortController();
    const taskState = { paused: false, cancelled: false, abortController: abortCtrl };
    activeTasks.set(taskId, taskState);

    const filename = `${sanitizeFilename(task.title)}.mp4`;
    const streamUrl = task.streamUrl;
    const isHls = streamUrl.includes('.m3u8') || task.format === 'hls';

    onProgress({
      status: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      speed: 'Connecting...'
    });

    try {
      // 1. Android Native Download Manager Fast-Path for direct MP4/MKV
      if (!isHls && typeof window !== 'undefined' && window.AndroidBridge?.downloadWithManager) {
        const launched = window.AndroidBridge.downloadWithManager(streamUrl, filename, 'video/mp4');
        if (launched) {
          onProgress({
            status: 'completed',
            progress: 100,
            speed: '',
            localFilePath: `Download/${filename}`
          });
          activeTasks.delete(taskId);
          return { success: true, filePath: `Download/${filename}` };
        }
      }

      // 2. HLS (.m3u8) Multi-Segment Worker Engine
      if (isHls) {
        return await this.downloadHlsStream(task, taskState, onProgress, filename);
      }

      // 3. Direct Binary Media Stream (MP4/MKV/WebM)
      return await this.downloadDirectStream(task, taskState, onProgress, filename);

    } catch (err) {
      if (taskState.cancelled) {
        onProgress({ status: 'failed', errorMessage: 'Download cancelled by user' });
        return { success: false, error: 'Cancelled' };
      }
      const msg = err?.message || String(err);
      console.error(`[Downloader] Download error for "${task.title}":`, err);
      onProgress({ status: 'failed', errorMessage: msg, error: msg });
      return { success: false, error: msg };
    } finally {
      activeTasks.delete(taskId);
    }
  },

  /**
   * Download multi-segment HLS stream
   */
  async downloadHlsStream(task, taskState, onProgress, filename) {
    const headers = task.headers || {};
    let playlistUrl = task.streamUrl;

    // Fetch initial playlist
    const res = await Showrush.http.get(playlistUrl, { headers });
    if (!res.ok || !res.data) {
      throw new Error(`Failed to fetch master playlist (HTTP ${res.status})`);
    }

    let playlistText = res.data;

    // Check for Master Variant Playlist
    if (playlistText.includes('#EXT-X-STREAM-INF:')) {
      const lines = playlistText.split('\n');
      let targetVariantUrl = null;
      let highestBandwidth = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const nextUrl = (lines[i + 1] || '').trim();
          if (nextUrl && !nextUrl.startsWith('#')) {
            if (bw > highestBandwidth) {
              highestBandwidth = bw;
              targetVariantUrl = resolveUrl(nextUrl, playlistUrl);
            }
          }
        }
      }

      if (targetVariantUrl) {
        playlistUrl = targetVariantUrl;
        const variantRes = await Showrush.http.get(playlistUrl, { headers });
        if (variantRes.ok && variantRes.data) {
          playlistText = variantRes.data;
        }
      }
    }

    // Parse Media Playlist Segments
    const segmentUrls = [];
    const lines = playlistText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#')) {
        segmentUrls.push(resolveUrl(line, playlistUrl));
      }
    }

    const totalSegments = segmentUrls.length;
    if (totalSegments === 0) {
      throw new Error('Playlist contains no media segments');
    }

    console.log(`[Downloader] Found ${totalSegments} segments for ${task.title}`);

    // Concurrency Worker Queue
    const concurrency = Math.max(1, Math.min(8, this.settings?.concurrency || 3));
    const segmentBuffers = new Array(totalSegments);
    let completedCount = 0;
    let accumulatedBytes = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let speedStr = '';

    const updateSpeed = () => {
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 1.0) {
        const bytesDiff = accumulatedBytes - lastBytes;
        speedStr = formatSpeed(bytesDiff / elapsed);
        lastBytes = accumulatedBytes;
        lastTime = now;
      }
    };

    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < totalSegments) {
        if (taskState.cancelled) return;
        while (taskState.paused) {
          await new Promise((r) => setTimeout(r, 500));
          if (taskState.cancelled) return;
        }

        const idx = nextIndex++;
        const segUrl = segmentUrls[idx];

        // Fetch segment with retry
        let buffer = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const segRes = await Showrush.http.get(segUrl, {
              headers,
              responseType: 'arraybuffer'
            });
            if (segRes.ok && segRes.arrayBuffer && segRes.arrayBuffer.byteLength > 0) {
              buffer = segRes.arrayBuffer;
              break;
            }
          } catch (e) {
            if (attempt === 2) throw e;
            await new Promise((r) => setTimeout(r, 800));
          }
        }

        if (!buffer) {
          throw new Error(`Failed to download segment #${idx + 1}`);
        }

        segmentBuffers[idx] = buffer;
        completedCount++;
        accumulatedBytes += buffer.byteLength;
        updateSpeed();

        const progressPercent = Math.min(99, Math.round((completedCount / totalSegments) * 100));
        const estimatedTotal = Math.round((accumulatedBytes / completedCount) * totalSegments);

        onProgress({
          status: 'downloading',
          progress: progressPercent,
          downloadedBytes: accumulatedBytes,
          totalBytes: estimatedTotal,
          speed: speedStr || formatSpeed(accumulatedBytes / Math.max(1, (Date.now() - lastTime) / 1000))
        });
      }
    };

    // Run parallel workers
    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (taskState.cancelled) {
      throw new Error('Download cancelled');
    }

    // Stitch segments together into continuous MPEG-TS / MP4 binary
    onProgress({ speed: 'Assembling file...', progress: 99 });
    const totalByteLength = segmentBuffers.reduce((sum, buf) => sum + (buf ? buf.byteLength : 0), 0);
    const mergedUint8 = new Uint8Array(totalByteLength);
    let byteOffset = 0;
    for (const buf of segmentBuffers) {
      if (buf) {
        mergedUint8.set(new Uint8Array(buf), byteOffset);
        byteOffset += buf.byteLength;
      }
    }

    // Create playable Blob
    const blob = new Blob([mergedUint8], { type: 'video/mp2t' });
    const localBlobUrl = URL.createObjectURL(blob);

    // Trigger save to local storage/downloads folder
    if (this.settings?.autoOpenOffline !== false) {
      triggerDownloadPrompt(localBlobUrl, filename);
    }

    onProgress({
      status: 'completed',
      progress: 100,
      downloadedBytes: totalByteLength,
      totalBytes: totalByteLength,
      speed: '',
      localFilePath: localBlobUrl
    });

    return { success: true, filePath: localBlobUrl };
  },

  /**
   * Direct media file downloader (MP4/MKV)
   */
  async downloadDirectStream(task, taskState, onProgress, filename) {
    const headers = task.headers || {};
    const res = await Showrush.http.get(task.streamUrl, {
      headers,
      responseType: 'arraybuffer'
    });

    if (!res.ok || !res.arrayBuffer) {
      throw new Error(`Failed to download media file (HTTP ${res.status})`);
    }

    const buffer = res.arrayBuffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const localBlobUrl = URL.createObjectURL(blob);

    if (this.settings?.autoOpenOffline !== false) {
      triggerDownloadPrompt(localBlobUrl, filename);
    }

    onProgress({
      status: 'completed',
      progress: 100,
      downloadedBytes: buffer.byteLength,
      totalBytes: buffer.byteLength,
      speed: '',
      localFilePath: localBlobUrl
    });

    return { success: true, filePath: localBlobUrl };
  },

  async pauseDownload(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
      task.paused = true;
      return true;
    }
    return false;
  },

  async cancelDownload(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
      task.cancelled = true;
      task.abortController?.abort();
      activeTasks.delete(taskId);
      return true;
    }
    return false;
  }
};
