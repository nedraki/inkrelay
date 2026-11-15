from io import BytesIO

from PIL import Image, ImageDraw

from .models import Page


def render_page_png(page: Page, max_dimension: int = 1600) -> bytes:
    """Render visible source strokes into a cropped, high-contrast PNG for vision input."""
    strokes = [
        stroke
        for stroke in page.strokes
        if stroke.semanticRole != "action" and stroke.points
    ]
    if not strokes:
        raise ValueError("The page has no visible ink to render")

    xs = [point.x for stroke in strokes for point in stroke.points]
    ys = [point.y for stroke in strokes for point in stroke.points]
    padding = max(24.0, min(page.width, page.height) * 0.025)
    left = max(0.0, min(xs) - padding)
    top = max(0.0, min(ys) - padding)
    right = min(page.width, max(xs) + padding)
    bottom = min(page.height, max(ys) + padding)
    crop_width = max(1.0, right - left)
    crop_height = max(1.0, bottom - top)
    scale = min(3.0, max_dimension / max(crop_width, crop_height))
    width = max(1, round(crop_width * scale))
    height = max(1, round(crop_height * scale))

    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    for stroke in strokes:
        points = [((point.x - left) * scale, (point.y - top) * scale) for point in stroke.points]
        line_width = max(3, round(stroke.style.width * scale * 1.4))
        if len(points) == 1:
            x, y = points[0]
            radius = line_width / 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill="#111111")
        else:
            draw.line(points, fill="#111111", width=line_width, joint="curve")

    output = BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()
