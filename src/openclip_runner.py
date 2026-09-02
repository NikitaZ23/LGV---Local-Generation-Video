import argparse
import json
import math
import sys


PROMPT_GROUPS = {
    "action": [
        "an intense action scene with fighting, chasing, running, danger, shooting or explosions",
        "a fast cinematic action moment with physical movement and conflict",
    ],
    "dialog": [
        "a close up conversation scene with people talking",
        "a dialogue scene focused on faces and characters speaking",
    ],
    "emotion": [
        "an emotional dramatic scene with fear, sadness, crying, shock or tension",
        "a tense dramatic movie moment with strong emotion on faces",
    ],
    "comedy": [
        "a funny comedy scene with laughing, jokes, silly behavior or absurd situation",
        "a humorous movie moment",
    ],
    "visual": [
        "a visually dynamic cinematic shot with strong motion, spectacle, crowd, fire, light or effects",
        "a striking memorable movie frame with high visual interest",
    ],
    "suspense": [
        "a suspenseful dangerous thriller or horror scene with threat and tension",
        "a dark tense scary cinematic moment",
    ],
    "calm": [
        "a calm quiet ordinary scene with little action",
        "a slow neutral movie scene",
    ],
}


def dependency_report():
    import importlib.util

    modules = ["torch", "open_clip", "PIL", "numpy", "cv2"]
    missing = [module for module in modules if importlib.util.find_spec(module) is None]
    return {
        "ok": not missing,
        "missing": missing,
        "modules": {module: module not in missing for module in modules},
    }


def parse_args():
    parser = argparse.ArgumentParser(description="Analyze video frames with OpenCLIP.")
    parser.add_argument("--check", action="store_true", help="Only check Python dependencies.")
    parser.add_argument("--video", default="", help="Video file path.")
    parser.add_argument("--model-path", default="", help="Local OpenCLIP weights file.")
    parser.add_argument("--model-name", default="ViT-B-32", help="OpenCLIP model architecture name.")
    parser.add_argument("--duration", type=float, default=0.0, help="Video duration in seconds.")
    parser.add_argument("--sample-step", type=float, default=8.0, help="Seconds between analyzed frames.")
    parser.add_argument("--max-frames", type=int, default=900, help="Maximum frames to analyze.")
    parser.add_argument("--batch-size", type=int, default=32, help="Batch size for OpenCLIP inference.")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"], help="Inference device.")
    return parser.parse_args()


def effective_sample_times(duration, requested_step, max_frames):
    safe_duration = max(0.0, float(duration or 0.0))
    if safe_duration <= 0:
        return [], max(1.0, requested_step)

    step = max(1.0, float(requested_step or 8.0))
    max_count = max(1, int(max_frames or 900))
    estimated = int(math.ceil(safe_duration / step))
    if estimated > max_count:
        step = safe_duration / max(1, max_count - 1)

    times = []
    current = 0.0
    while current < safe_duration and len(times) < max_count:
        times.append(round(min(current, max(0.0, safe_duration - 0.05)), 3))
        current += step

    if not times:
        times.append(0.0)
    return times, step


def video_duration_from_capture(cap):
    fps = float(cap.get(5) or 0.0)
    frame_count = float(cap.get(7) or 0.0)
    if fps > 0 and frame_count > 0:
        return frame_count / fps
    return 0.0


def read_frame_at(cap, time_seconds):
    import cv2

    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(time_seconds)) * 1000.0)
    ok, frame = cap.read()
    if not ok or frame is None:
        return None
    return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)


def grouped_text_features(model, tokenizer, device):
    import torch

    labels = list(PROMPT_GROUPS.keys())
    prompts = []
    group_sizes = []
    for label in labels:
        group = PROMPT_GROUPS[label]
        prompts.extend(group)
        group_sizes.append(len(group))

    tokens = tokenizer(prompts).to(device)
    with torch.inference_mode():
        features = model.encode_text(tokens)
        features = features / features.norm(dim=-1, keepdim=True)

    grouped = []
    offset = 0
    for size in group_sizes:
        group_features = features[offset:offset + size].mean(dim=0)
        group_features = group_features / group_features.norm(dim=-1, keepdim=True)
        grouped.append(group_features)
        offset += size

    return labels, torch.stack(grouped)


def analyze_frames(args):
    deps = dependency_report()
    if not deps["ok"]:
        return {
            "ok": False,
            "error": "Не установлены Python-пакеты для OpenCLIP: " + ", ".join(deps["missing"]),
            "dependencies": deps,
        }

    import cv2
    from PIL import Image
    import torch
    import open_clip

    if not args.video:
        raise ValueError("Не указан видеофайл.")
    if not args.model_path:
        raise ValueError("Не указан файл модели OpenCLIP.")

    device = "cuda" if args.device == "auto" and torch.cuda.is_available() else args.device
    if device == "auto":
        device = "cpu"

    model, _, preprocess = open_clip.create_model_and_transforms(
        args.model_name,
        pretrained=args.model_path,
        device=device,
    )
    model.eval()
    tokenizer = open_clip.get_tokenizer(args.model_name)
    labels, text_features = grouped_text_features(model, tokenizer, device)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise ValueError("OpenCV не смог открыть видеофайл.")

    duration = args.duration if args.duration > 0 else video_duration_from_capture(cap)
    times, effective_step = effective_sample_times(duration, args.sample_step, args.max_frames)
    batch_size = max(1, int(args.batch_size or 32))

    points = []
    images = []
    image_times = []

    def flush_batch():
        if not images:
            return

        batch = torch.stack(images).to(device)
        with torch.inference_mode():
            image_features = model.encode_image(batch)
            image_features = image_features / image_features.norm(dim=-1, keepdim=True)
            logits = 100.0 * image_features @ text_features.T
            probabilities = logits.softmax(dim=-1).detach().cpu().tolist()

        for time_value, probs in zip(image_times, probabilities):
            scores = {label: round(float(prob), 6) for label, prob in zip(labels, probs)}
            top_label = max(scores, key=scores.get)
            points.append({
                "time": round(float(time_value), 3),
                "top": top_label,
                "confidence": scores[top_label],
                "scores": scores,
            })

        images.clear()
        image_times.clear()

    for time_value in times:
        frame = read_frame_at(cap, time_value)
        if frame is None:
            continue

        image = Image.fromarray(frame)
        images.append(preprocess(image))
        image_times.append(time_value)

        if len(images) >= batch_size:
            flush_batch()

    flush_batch()
    cap.release()

    return {
        "ok": True,
        "modelName": args.model_name,
        "modelPath": args.model_path,
        "device": device,
        "sampleStep": round(float(effective_step), 3),
        "frameCount": len(points),
        "duration": round(float(duration), 3),
        "labels": labels,
        "points": points,
    }


def main():
    args = parse_args()
    if args.check:
        print(json.dumps(dependency_report(), ensure_ascii=False))
        return 0

    try:
        result = analyze_frames(args)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") else 2
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
