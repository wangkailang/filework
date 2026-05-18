#!/usr/bin/env python3
"""
Extract all content from a PowerPoint file (.pptx).
Returns a JSON structure with slides, text, images, and notes.

Usage:
    python3 extract-pptx.py <input.pptx> [output_dir]

Requires:
    pip install python-pptx

Output:
    <output_dir>/extracted-slides.json
    <output_dir>/assets/slide{N}_img{M}.{ext}
"""

import json
import os
import sys

try:
    from pptx import Presentation
except ImportError:
    print("ERROR: python-pptx not installed. Run: pip install python-pptx", file=sys.stderr)
    sys.exit(2)


def extract_pptx(file_path: str, output_dir: str = ".") -> list:
    """Extract slides from a .pptx into a list of dicts."""
    prs = Presentation(file_path)
    slides_data = []

    assets_dir = os.path.join(output_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)

    for slide_num, slide in enumerate(prs.slides, start=1):
        slide_data = {
            "number": slide_num,
            "title": "",
            "content": [],
            "images": [],
            "notes": "",
        }

        for shape in slide.shapes:
            # Title vs. body text
            if shape.has_text_frame:
                text = shape.text.strip()
                if not text:
                    continue
                if shape == slide.shapes.title:
                    slide_data["title"] = text
                else:
                    slide_data["content"].append({"type": "text", "content": text})

            # Pictures (MSO_SHAPE_TYPE.PICTURE == 13)
            if shape.shape_type == 13:
                image = shape.image
                image_bytes = image.blob
                image_ext = image.ext
                image_name = (
                    f"slide{slide_num}_img{len(slide_data['images']) + 1}.{image_ext}"
                )
                image_path = os.path.join(assets_dir, image_name)
                with open(image_path, "wb") as f:
                    f.write(image_bytes)
                slide_data["images"].append(
                    {
                        "path": f"assets/{image_name}",
                        "width": shape.width,
                        "height": shape.height,
                    }
                )

        # Speaker notes
        if slide.has_notes_slide:
            notes_text = slide.notes_slide.notes_text_frame.text.strip()
            if notes_text:
                slide_data["notes"] = notes_text

        slides_data.append(slide_data)

    return slides_data


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 extract-pptx.py <input.pptx> [output_dir]", file=sys.stderr)
        return 1

    input_file = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "."

    if not os.path.isfile(input_file):
        print(f"ERROR: input file not found: {input_file}", file=sys.stderr)
        return 1

    os.makedirs(output_dir, exist_ok=True)
    slides = extract_pptx(input_file, output_dir)

    output_path = os.path.join(output_dir, "extracted-slides.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(slides, f, indent=2, ensure_ascii=False)

    print(f"Extracted {len(slides)} slide(s) to {output_path}")
    for s in slides:
        img_count = len(s["images"])
        title = s["title"] or "(no title)"
        print(f"  Slide {s['number']}: {title} - {img_count} image(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
