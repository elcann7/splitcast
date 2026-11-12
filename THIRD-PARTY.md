# Third-party components

Splitcast's own code is MIT-licensed (see `LICENSE`). The installer and the app also use the components below, which keep their own licences. This list is a good-faith summary; the upstream projects are authoritative.

## Models (downloaded or bundled as data, never part of the source code)

| Model | Used for | Licence / terms |
|---|---|---|
| SCRFD, ArcFace (InsightFace `buffalo_l` and related packs) | face detection and recognition | **Non-commercial research use only.** If you use Splitcast's results commercially, check the InsightFace terms first. |
| TransNetV2 (ONNX export) | shot boundaries | Third-party ONNX export of TransNetV2; see its source for terms. |
| deepghs anime face detector (YOLOv8) | anime faces | MIT |
| deepghs CCIP | anime character identity | OpenRAIL |

## Programs and libraries shipped in the installer

| Component | Licence | Note |
|---|---|---|
| **ffmpeg / ffprobe** (BtbN "win64-gpl" build) | **GPL** (with x264/x265 and others) | Shipped unmodified as a separate program that Splitcast starts as a subprocess. Source and build scripts: https://github.com/BtbN/FFmpeg-Builds and https://ffmpeg.org |
| Python 3.12 (embedded) | PSF License | https://docs.python.org/3/license.html |
| ONNX Runtime (CUDA and DirectML builds) | MIT | |
| NVIDIA CUDA / cuDNN runtime libraries (via PyPI `nvidia-*` wheels) | NVIDIA software licences | Redistributed as supplied by NVIDIA's wheels |
| PyAV, OpenCV (headless), NumPy, SciPy, Pillow | BSD / Apache-2.0 / LGPL (PyAV, with bundled FFmpeg libraries) | |
| Flask, flask-cors, waitress, requests, pywebview | BSD / MIT / ZPL | |
| React, Vite, Tailwind CSS, zustand, lucide-react | MIT / ISC | |
| Geist and Geist Mono fonts | SIL Open Font License 1.1 | |
| Country flag images on the website (flag-icons) | MIT | |

## Demo footage

*Tears of Steel* (c) Blender Foundation, https://mango.blender.org, CC-BY 3.0. Used only for screenshots.