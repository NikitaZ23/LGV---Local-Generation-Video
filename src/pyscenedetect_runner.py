import argparse
import json
import sys
import warnings


def clamp(value, minimum, maximum):
    return min(maximum, max(minimum, value))


def sensitivity_to_thresholds(scene_threshold):
    normalized = clamp((scene_threshold - 0.15) / 0.60, 0.0, 1.0)
    return {
        "content": 18.0 + normalized * 27.0,
        "adaptive": 2.2 + normalized * 1.6,
        "min_content": 10.0 + normalized * 12.0,
        "fade": 12.0,
    }


def seconds_of(timecode):
    seconds = getattr(timecode, "seconds", None)
    if seconds is not None:
        return float(seconds)
    return float(timecode.get_seconds())


def detect_scenes(args):
    from scenedetect import SceneManager, open_video
    from scenedetect.detectors import AdaptiveDetector, ContentDetector, ThresholdDetector

    thresholds = sensitivity_to_thresholds(args.scene_threshold)
    video = open_video(args.video)
    fps = float(video.frame_rate)
    min_scene_len = max(1, int(round(max(args.min_gap, 0.5) * fps)))
    manager = SceneManager()
    detectors = []

    if args.scene_mode == "manual":
        manager.add_detector(ContentDetector(
            threshold=thresholds["content"],
            min_scene_len=min_scene_len,
        ))
        detectors.append("контент")
    else:
        manager.add_detector(AdaptiveDetector(
            adaptive_threshold=thresholds["adaptive"],
            min_content_val=thresholds["min_content"],
            min_scene_len=min_scene_len,
        ))
        detectors.append("адаптивный")

    if args.quality == "precise":
        manager.add_detector(ThresholdDetector(
            threshold=thresholds["fade"],
            min_scene_len=min_scene_len,
            add_final_scene=False,
        ))
        detectors.append("яркость/затемнения")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        manager.detect_scenes(video=video, show_progress=False)

    scene_list = manager.get_scene_list()
    scenes = []
    boundaries = []
    for index, (start, _end) in enumerate(scene_list):
        start_seconds = seconds_of(start)
        end_seconds = seconds_of(_end)
        scenes.append({
            "start": round(start_seconds, 3),
            "end": round(end_seconds, 3),
            "duration": round(max(0.0, end_seconds - start_seconds), 3),
        })
        if index == 0:
            continue
        time = start_seconds
        if time >= 0.5:
            boundaries.append(round(time, 3))

    return {
        "ok": True,
        "times": boundaries,
        "scenes": scenes,
        "sceneCount": len(scene_list),
        "boundaryCount": len(boundaries),
        "detectors": detectors,
        "thresholds": {
            "content": round(thresholds["content"], 3),
            "adaptive": round(thresholds["adaptive"], 3),
            "minContent": round(thresholds["min_content"], 3),
            "fade": round(thresholds["fade"], 3),
        },
        "minSceneLenFrames": min_scene_len,
        "fps": round(fps, 3),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--quality", choices=["fast", "precise"], default="precise")
    parser.add_argument("--scene-mode", choices=["auto", "manual"], default="auto")
    parser.add_argument("--scene-threshold", type=float, default=0.35)
    parser.add_argument("--min-gap", type=float, default=1.25)
    args = parser.parse_args()

    try:
        result = detect_scenes(args)
    except Exception as exc:
        result = {
            "ok": False,
            "error": str(exc),
        }

    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
