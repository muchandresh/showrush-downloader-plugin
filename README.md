# 📥 Showrush Downloader Plugin Repository

Official standalone downloader repository for the **Showrush** streaming ecosystem.

## 🚀 Plugins Included
- **Showrush Stream & HLS Downloader (`com.showrush.downloader`)**:
  - Direct MP4 / MKV / WebM offline downloading.
  - Multi-segment HLS (`.m3u8`) streaming assembler with concurrent chunk workers.
  - Native Android `DownloadManager` support via `AndroidBridge`.
  - Pause, resume, and real-time speed & progress calculation.

## 📦 How to Use in Showrush
Add this repository manifest URL in **Showrush Settings > Extensions > Add Repository**:
```
https://raw.githubusercontent.com/muchandresh/showrush-downloader-plugin/refs/heads/master/repository.json
```
Or install directly from the local bundle.
